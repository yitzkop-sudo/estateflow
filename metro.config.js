const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Keep Metro from crawling/bundling server-only and build-output dirs.
// These are not imported by src/ (verified) and massively slow down the
// file-map crawl, which was stalling the bundler and producing bad bundles.
config.resolver.blockList = [
  /.*\/functions\/.*/,
  /.*\/netlify\/.*/,
  /.*\/api\/.*/,
  /.*\/dist\/.*/,
  /.*\/\.firebase\/.*/,
  /.*\/wp-templates\/.*/,
  /.*\/web\/.*/,
];

module.exports = config;
