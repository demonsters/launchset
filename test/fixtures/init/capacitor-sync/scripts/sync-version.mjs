import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const [major, minor, patch] = version.split(".").map(Number);
const build = major * 1000000 + minor * 10000 + patch * 100 + 99;

const gradle = readFileSync("android/app/build.gradle", "utf8")
  .replace(/versionCode \d+/, `versionCode ${build}`)
  .replace(/versionName "[^"]*"/, `versionName "${version}"`);
writeFileSync("android/app/build.gradle", gradle);

const pbx = "ios/App/App.xcodeproj/project.pbxproj";
writeFileSync(
  pbx,
  readFileSync(pbx, "utf8")
    .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`)
    .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${build};`),
);
