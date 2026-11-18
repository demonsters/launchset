export default {
  baseBranch: "develop",
  targets: {
    web: { type: "web" },
    android: { type: "android", source: { kind: "gradle", file: "android/app/build.gradle.kts" } },
  },
};
