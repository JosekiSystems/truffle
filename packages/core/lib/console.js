const repl = require("repl");
const Command = require("./command");
const provision = require("@truffle/provisioner");
const {
  Web3Shim,
  createInterfaceAdapter
} = require("@truffle/interface-adapter");
const contract = require("@truffle/contract");
const vm = require("vm");
const expect = require("@truffle/expect");
const TruffleError = require("@truffle/error");
const fse = require("fs-extra");
const path = require("path");
const EventEmitter = require("events");
const spawnSync = require("child_process").spawnSync;

const processInput = input => {
  const inputComponents = input.trim().split(" ");
  if (inputComponents.length === 0) return input;

  if (inputComponents[0] === "truffle") {
    return inputComponents.slice(1).join(" ");
  }
  return input.trim();
};

class Console extends EventEmitter {
  constructor(tasks, options) {
    super();
    EventEmitter.call(this);

    expect.options(options, [
      "working_directory",
      "contracts_directory",
      "contracts_build_directory",
      "migrations_directory",
      "networks",
      "network",
      "network_id",
      "provider",
      "resolver",
      "build_directory"
    ]);

    this.options = options;

    this.command = new Command(tasks);

    this.repl = null;

    this.interfaceAdapter = createInterfaceAdapter({
      provider: options.provider,
      networkType: options.networks[options.network].type
    });
    this.web3 = new Web3Shim({
      provider: options.provider,
      networkType: options.networks[options.network].type
    });
  }

  start() {
    try {
      this.interfaceAdapter.getAccounts().then(() => {
        const abstractions = this.provision();

        this.repl = repl.start({
          prompt: "truffle(" + this.options.network + ")> ",
          eval: this.interpret.bind(this)
        });

        this.resetContractsInConsoleContext(abstractions);
      });
    } catch (error) {
      this.options.logger.log(
        "Unexpected error: Cannot provision contracts while instantiating the console."
      );
      this.options.logger.log(error.stack || error.message || error);
    }
  }

  provision() {
    let files;
    try {
      const unfilteredFiles = fse.readdirSync(
        this.options.contracts_build_directory
      );
      files = unfilteredFiles.filter(file => file.endsWith(".json"));
    } catch (error) {
      // Error reading the build directory? Must mean it doesn't exist or we don't have access to it.
      // Couldn't provision the contracts if we wanted. It's possible we're hiding very rare FS
      // errors, but that's better than showing the user error messages that will be "build folder
      // doesn't exist" 99.9% of the time.
    }

    let jsonBlobs = [];
    files = files || [];

    files.forEach(file => {
      try {
        const body = fse.readFileSync(
          path.join(this.options.contracts_build_directory, file),
          "utf8"
        );
        jsonBlobs.push(JSON.parse(body));
      } catch (error) {
        throw new Error(`Error parsing or reading ${file}: ${error.message}`);
      }
    });

    const abstractions = jsonBlobs.map(json => {
      const abstraction = contract(json);
      provision(abstraction, this.options);
      return abstraction;
    });

    this.resetContractsInConsoleContext(abstractions);

    return abstractions;
  }

  resetContractsInConsoleContext(abstractions) {
    abstractions = abstractions || [];

    const contextVars = {};

    abstractions.forEach(abstraction => {
      contextVars[abstraction.contract_name] = abstraction;
    });
  }

  runSpawn(inputStrings, options, callback) {
    let args;
    if (typeof BUNDLE_CONSOLE_CHILD_FILENAME !== "undefined") {
      args = path.join(__dirname, BUNDLE_CONSOLE_CHILD_FILENAME);
    } else {
      args = path.join(__dirname, "../lib/console-child.js");
    }

    const spawnOptions = { stdio: ["inherit", "inherit", "inherit"] };

    try {
      //serialize config networks entries
      const configNetworks = {};
      for (const key in options.networks) {
        configNetworks[key] = JSON.stringify(options.networks[key]);
      }

      spawnSync(
        "node",
        [args, inputStrings, JSON.stringify({ networks: configNetworks })],
        spawnOptions
      );

      try {
        this.provision();
      } catch (e) {
        console.log(e);
      }
    } catch (err) {
      callback(err);
    }
    //want repl to exit when it receives an exit command
    this.repl.on("exit", () => {
      process.exit();
    });
    //display prompt when child repl process is finished
    this.repl.displayPrompt();
  }

  interpret(input, context, filename, callback) {
    const processedInput = processInput(input);
    if (
      this.command.getCommand(processedInput, this.options.noAliases) != null
    ) {
      return this.runSpawn(processedInput, this.options, error => {
        if (error) {
          // Perform error handling ourselves.
          if (error instanceof TruffleError) {
            console.log(error.message);
          } else {
            // Bubble up all other unexpected errors.
            console.log(error.stack || error.toString());
          }
          return callback();
        }

        // Reprovision after each command as it may change contracts.
        try {
          this.provision();
          callback();
        } catch (error) {
          // Don't pass abstractions to the callback if they're there or else
          // they'll get printed in the repl.
          callback(error);
        }
      });
    }

    // Much of the following code is from here, though spruced up:
    // https://github.com/nfcampos/await-outside

    /*
    - allow whitespace before everything else
    - optionally capture `var|let|const <varname> = `
      - varname only matches if it starts with a-Z or _ or $
        and if contains only those chars or numbers
      - this is overly restrictive but is easier to maintain
    - capture `await <anything that follows it>`
    */
    let includesAwait = /^\s*((?:(?:var|const|let)\s+)?[a-zA-Z_$][0-9a-zA-Z_$]*\s*=\s*)?(\(?\s*await[\s\S]*)/;

    const match = processedInput.match(includesAwait);
    let source = processedInput;
    let assignment = null;

    // If our code includes an await, add special processing to ensure it's evaluated properly.
    if (match) {
      let assign = match[1];

      const expression =
        match[2] && match[2].endsWith(";")
          ? // strip off trailing ";" to prevent the expression below from erroring
            match[2].slice(0, -1)
          : match[2];

      const RESULT = "__await_outside_result";

      // Wrap the await inside an async function.
      // Strange indentation keeps column offset correct in stack traces
      source = `(async function() { try { ${
        assign ? `global.${RESULT} =` : "return"
      } (
  ${expression.trim()}
  ); } catch(e) { global.ERROR = e; throw e; } }())`;

      assignment = assign
        ? `${assign.trim()} global.${RESULT}; void delete global.${RESULT};`
        : null;
    }

    const runScript = script => {
      const options = {
        displayErrors: true,
        breakOnSigint: true,
        filename: filename
      };
      return script.runInContext(context, options);
    };

    let script;
    try {
      const options = { displayErrors: true, lineOffset: -1 };
      script = vm.createScript(source, options);
    } catch (error) {
      // If syntax error, or similar, bail.
      return callback(error);
    }

    // Ensure our script returns a promise whether we're using an
    // async function or not. If our script is an async function,
    // this will ensure the console waits until that await is finished.
    Promise.resolve(runScript(script))
      .then(value => {
        // If there's an assignment to run, run that.
        if (assignment) return runScript(vm.createScript(assignment));
        return value;
      })
      .then(value => {
        // All good? Return the value (e.g., eval'd script or assignment)
        callback(null, value);
      })
      .catch(callback);
  }
}

module.exports = Console;
