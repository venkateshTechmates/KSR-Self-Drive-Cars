// The app reuses the booking rules, IST time helpers, money formatting and validation from
// ../shared (the same code the website and server use), so Metro watches that folder too.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '../shared')];

module.exports = config;
