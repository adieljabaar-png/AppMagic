const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const archiver = require('archiver');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ---------- Helpers ----------

const runCmd = (cmd, cwd) =>
  new Promise((resolve, reject) => {
    exec(cmd, { cwd, maxBuffer: 50 * 1024 * 1024, timeout: 600000 }, (err, stdout, stderr) => {
      if (err) {
        console.error(`❌ Command failed: ${cmd}\n${stderr}`);
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout);
      }
    });
  });

const injectPermissions = async (filePath, injection, marker) => {
  if (!(await fs.pathExists(filePath))) return;
  let content = await fs.readFile(filePath, 'utf8');
  if (content.includes(marker)) return; // already injected

  if (filePath.endsWith('Info.plist')) {
    // Insert before the closing </dict> of the root <plist> dict
    content = content.replace(/(<\/dict>\s*<\/plist>)/, `${injection}\n$1`);
  } else {
    // Insert before <application> in AndroidManifest.xml
    content = content.replace('<application', `${injection}\n<application`);
  }
  await fs.writeFile(filePath, content);
};

const makeZip = (workDir, zipPath, rootName) =>
  new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(workDir, rootName);
    archive.finalize();
  });

// ---------- Routes ----------

app.post('/api/convert', upload.single('htmlFile'), async (req, res) => {
  const { appName, packageId } = req.body;
  const htmlFile = req.file;

  if (!appName || !packageId || !htmlFile) {
    return res.status(400).json({ error: 'Missing appName, packageId, or htmlFile' });
  }

  const safeName = appName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  const workDir = path.join(__dirname, `temp-build-${Date.now()}`);
  const webDir = path.join(workDir, 'www');
  await fs.ensureDir(webDir);

  try {
    // 1. Copy uploaded HTML as index.html
    await fs.copy(htmlFile.path, path.join(webDir, 'index.html'));

    // 2. package.json with all plugins
    const pkgJson = {
      name: safeName,
      version: '1.0.0',
      description: 'Converted via HTML to Native Converter',
      dependencies: {
        '@capacitor/core': '^7.0.0',
        '@capacitor/android': '^7.0.0',
        '@capacitor/ios': '^7.0.0',
        '@capacitor/camera': '^7.0.0',
        '@capacitor/geolocation': '^7.0.0',
        'capacitor-voice-recorder': '^6.0.0',
      },
      devDependencies: {
        '@capacitor/cli': '^7.0.0',
      },
    };
    await fs.writeJson(path.join(workDir, 'package.json'), pkgJson, { spaces: 2 });

    console.log('📦 Installing dependencies...');
    await runCmd('npm install --legacy-peer-deps', workDir);

    console.log('⚙️ Initializing Capacitor...');
    await runCmd(`npx cap init "${appName}" "${packageId}" --web-dir=www`, workDir);

    console.log('🤖 Adding Android...');
    await runCmd('npx cap add android', workDir);

    console.log('🍎 Adding iOS...');
    await runCmd('npx cap add ios', workDir);

    console.log('🔐 Injecting permissions...');

    // iOS: Info.plist
    const iosPerms = `
	<key>NSCameraUsageDescription</key>
	<string>This app needs camera access to take photos.</string>
	<key>NSMicrophoneUsageDescription</key>
	<string>This app needs microphone access to record audio.</string>
	<key>NSLocationWhenInUseUsageDescription</key>
	<string>This app needs location access to show your position.</string>
	<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
	<string>This app needs location access to show your position.</string>
	<key>NSPhotoLibraryUsageDescription</key>
	<string>This app needs photo library access to select images.</string>
	<key>NSPhotoLibraryAddUsageDescription</key>
	<string>This app needs photo library access to save images.</string>`;

    await injectPermissions(
      path.join(workDir, 'ios', 'App', 'App', 'Info.plist'),
      iosPerms,
      'NSCameraUsageDescription'
    );

    // Android: AndroidManifest.xml
    const androidPerms = `
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
    <uses-feature android:name="android.hardware.location.gps" />
    <uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />
    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />`;

    await injectPermissions(
      path.join(workDir, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
      androidPerms,
      'android.permission.CAMERA'
    );

    console.log('🔄 Syncing plugins...');
    await runCmd('npx cap sync', workDir);

    // 3. README
    const readme = `# ${appName}

Generated: ${new Date().toISOString()}
Package ID: ${packageId}

## Included Plugins
- @capacitor/camera (Camera + Photo Library)
- @capacitor/geolocation (GPS / Location)
- capacitor-voice-recorder (Microphone)

## Build Android
1. Install Android Studio: https://developer.android.com/studio
2. Open the \`android/\` folder in Android Studio
3. Wait for Gradle sync to complete
4. Build > Build Bundle(s) / APK(s) > Build APK(s)
5. For Play Store: Build > Generate Signed Bundle / APK > Android App Bundle

## Build iOS (requires macOS + Xcode)
1. Open \`ios/App/App.xcworkspace\` in Xcode
2. Select your Team under Signing & Capabilities
3. Product > Archive
4. Distribute App > App Store Connect

## Using Plugins in Your HTML
Plugins are available via the \`Capacitor.Plugins\` global inside the WebView:

\`\`\`javascript
// Camera
const photo = await Capacitor.Plugins.Camera.getPhoto({ resultType: 'uri', quality: 90 });

// Geolocation
const pos = await Capacitor.Plugins.Geolocation.getCurrentPosition();

// Voice Recorder
await Capacitor.Plugins.VoiceRecorder.requestAudioRecordingPermission();
await Capacitor.Plugins.VoiceRecorder.startRecording();
\`\`\`

## Publishing Costs
- Apple Developer Program: $99/year
- Google Play Console: $25 one-time

## Important
- Native plugins only work when built and run via Android Studio / Xcode (NOT in a browser)
- Set your app icons and splash screens before submitting
- Apple rejects apps that are just wrapped websites (Guideline 4.2) — use the native plugins to provide real functionality
`;

    await fs.writeFile(path.join(workDir, 'README.md'), readme);

    // 4. Clean heavy folders to shrink ZIP
    await fs.remove(path.join(workDir, 'node_modules')).catch(() => {});
    await fs.remove(path.join(workDir, 'android', '.gradle')).catch(() => {});
    await fs.remove(path.join(workDir, 'android', 'build')).catch(() => {});
    await fs.remove(path.join(workDir, 'android', 'app', 'build')).catch(() => {});
    await fs.remove(path.join(workDir, 'ios', 'App', 'Pods')).catch(() => {});

    // 5. ZIP + download
    const zipPath = path.join(__dirname, `projects-${Date.now()}.zip`);
    await makeZip(workDir, zipPath, safeName);

    res.download(zipPath, `${safeName}-native.zip`, async () => {
      await fs.remove(workDir).catch(() => {});
      await fs.remove(zipPath).catch(() => {});
      await fs.remove(htmlFile.path).catch(() => {});
    });
  } catch (error) {
    console.error('Build failed:', error);
    res.status(500).json({ error: error.message });
    await fs.remove(workDir).catch(() => {});
    await fs.remove(htmlFile.path).catch(() => {});
  }
});

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(3000, () => console.log('🚀 Converter running at http://localhost:3000'));