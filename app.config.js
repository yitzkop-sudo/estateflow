// Dynamic Expo config wrapper.
//
// app.json stays the single source of truth. This file only *adds* the
// googleServicesFile references when the files actually exist in the
// project root. Referencing a missing file crashes config resolution
// (withIosInfoPlistBaseMod: ENOENT), so static refs in app.json would break
// `expo start`, `prebuild`, and EAS commands before the Firebase files are
// downloaded. Once GoogleService-Info.plist / google-services.json are in
// place, they are picked up automatically — no config change needed.
const fs = require("fs");
const path = require("path");

const base = require("./app.json").expo;

const IOS_PLIST = "./GoogleService-Info.plist";
const ANDROID_JSON = "./google-services.json";

function ifExists(relativePath) {
  return fs.existsSync(path.join(__dirname, relativePath))
    ? true
    : false;
}

module.exports = {
  expo: {
    ...base,
    ios: {
      ...base.ios,
      ...(ifExists(IOS_PLIST) ? { googleServicesFile: IOS_PLIST } : {}),
    },
    android: {
      ...base.android,
      ...(ifExists(ANDROID_JSON) ? { googleServicesFile: ANDROID_JSON } : {}),
    },
  },
};
