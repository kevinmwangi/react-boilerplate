process.env.NODE_ENV = 'development';

if (require('dotenv').config().error) {
  return process.exit(0);
}

const { join } = require('path');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const webpack = require('webpack');
const WebpackDevServer = require('webpack-dev-server');
const del = require('del');
const ora = require('ora');
const chokidar = require('chokidar');
const { red, yellow, blue } = require('chalk');
const paths = require('./config/paths');
const clientConfig = require('./config/webpack/client.js');
const serverConfig = require('./config/webpack/server.js');
const clearConsole = require('./utils/clearConsole');
const formatWebpackMessages = require('./utils/formatWebpackMessages');

class Emitter extends EventEmitter {}
const emitter = new Emitter();

// Only development build messages.
function printPrettyMessages(messages, spinner, buildTarget) {
  if (messages.errors.length) {
    spinner.fail(red(`Failed to ${buildTarget} compile.`));
    console.log();
    messages.errors.forEach(message => console.log(message));
    return;
  }

  if (messages.warnings.length) {
    spinner.succeed(yellow(`Compiled ${buildTarget} with warnings.`));
    console.log();
    messages.warnings.forEach(message => console.log(message));
  }

  if (!messages.errors.length && !messages.warnings.length) {
    spinner.succeed(blue(`Successfully ${buildTarget} compiled.`));
  }
}

function configureClient() {
  const compiler = webpack(clientConfig);
  const spinner = ora('Compiling client.');

  compiler.plugin('compile', () => {
    clearConsole();
    spinner.start();
  });

  compiler.plugin('done', (stats) => {
    const messages = formatWebpackMessages(stats.toJson({}, true));
    printPrettyMessages(messages, spinner, 'client');
    if (!messages.errors.length) {
      emitter.emit('server-compile');
    }
  });

  emitter.on('client-compile', () => {
    const server = new WebpackDevServer(compiler, {
      hot: true,
      noInfo: true,
      quiet: true,
      historyApiFallback: true,
      // Prevent CORS error when failed to compile.
      headers: {
        'Access-Control-Allow-Origin': '*',
      },
    });
    server.listen(process.env.DEV_PORT);
  });
}

function configureServer() {
  let server;

  const compiler = webpack(serverConfig);
  const spinner = ora('Compiling server.');

  compiler.plugin('compile', () => spinner.start());
  compiler.plugin('done', (stats) => {
    const messages = formatWebpackMessages(stats.toJson({}, true));
    printPrettyMessages(messages, spinner, 'server');
    if (!messages.errors.length) {
      emitter.emit('server-restart');
    }
  });

  emitter.on('server-compile', (doClearConsole) => {
    if (doClearConsole) {
      clearConsole();
    }
    compiler.run(() => {});
  });
  emitter.on('server-restart', () => {
    if (server) {
      server.kill();
      server = null;
    }
    emitter.emit('server-run');
  });
  emitter.on('server-run', () => {
    server = spawn(
      process.argv[0],
      ['--trace-warnings', '-r', 'source-map-support/register', join(paths.build, 'server.js')],
      { stdio: [process.stdin, 'pipe', 'pipe'] }
    );

    server.on('error', (error) => {
      console.log(red(error));
      console.log();
    });
    server.on('close', (code) => {
      if (code !== null && code !== '0') {
        const message = `Server process exited with code ${code}. Process will restart after 5s.`;
        console.log(yellow(message));
        console.log();
        setTimeout(() => emitter.emit('server-restart'), 5000);
      }
    });

    server.stdout.on('data', data => console.log(data.toString()));
    server.stderr.on('data', data => console.log(data.toString()));
  });

  // Watch sources
  const sourceWatcher = chokidar.watch([paths.server]);
  sourceWatcher.on('ready', () => {
    ['add', 'addDir', 'change', 'unlink', 'unlinkDir'].forEach(e => sourceWatcher.on(e, () => {
      emitter.emit('server-compile', true);
    }));
  });

  // Watch process exit
  process.on('exit', () => {
    if (server) {
      server.kill();
    }
  });
}

function watchWebpackConfig() {
  const configWatcher = chokidar.watch([
    paths.webpackClientConfig,
    paths.webpackServerConfig,
  ]);
  configWatcher.on('ready', () => {
    configWatcher.on('change', () => {
      const message = 'Webpack config changed. Please restart your development server.';
      console.log(yellow(`* ${message}`));
      console.log();
      process.exit(0);
    });
  });
}

// Start
del.sync(paths.build);
watchWebpackConfig();
configureClient();
configureServer();

emitter.emit('client-compile');
