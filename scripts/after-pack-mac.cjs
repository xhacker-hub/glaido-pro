const { execSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

exports.default = async function (context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const entitlementsPath = path.join(context.packager.projectDir, "macos-agent", "entitlements.plist");

  // 1. Sign bundled ffmpeg binary with audio-input entitlements
  const ffmpegPath = path.join(appPath, "Contents", "Resources", "app", "node_modules", "ffmpeg-static", "ffmpeg");
  if (fs.existsSync(ffmpegPath)) {
    try {
      execSync(`codesign --force --sign - --entitlements "${entitlementsPath}" "${ffmpegPath}"`, {
        stdio: "inherit"
      });
      console.log(`[afterPack] Ad-hoc signed bundled ffmpeg: ${ffmpegPath}`);
    } catch (err) {
      console.warn(`[afterPack] Warning signing ffmpeg: ${err?.message || err}`);
    }
  }

  // 2. Sign the entire .app bundle deeply with entitlements and sealed Info.plist
  console.log(`[afterPack] Applying deep ad-hoc codesign with entitlements to: ${appPath}`);
  execSync(`codesign --force --deep --sign - --entitlements "${entitlementsPath}" "${appPath}"`, {
    stdio: "inherit"
  });

  // 3. Verify signature
  const verifyOut = execSync(`codesign -dvvv "${appPath}" 2>&1`, { encoding: "utf8" });
  console.log(`[afterPack] Codesign verified:\n${verifyOut.split("\n").slice(0, 8).join("\n")}`);
};
