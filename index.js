const Runner = require('./src/Runner/Runner');

/**
 * Path da pasta do core
 * @type {string}
 */
const path = '../infrashop-core/core-site';

new Runner(path).start();