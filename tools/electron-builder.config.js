'use strict';
const fs = require('fs'), path = require('path');
const config = { ...require('../package.json').build };
const { stage } = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../.desktop-resources/current.json'), 'utf8'));
config.extraResources = [{ from: stage, to: 'app', filter: ['**/*', '!main.js', '!preload.js', '!player-storage.js', '!package.json', '!window-state.json', '!_deck_diag.json', '!_deck_restore.done'] }];
module.exports = config;
