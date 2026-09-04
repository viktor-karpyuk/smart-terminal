/**
 * Packaging, in JavaScript rather than in package.json, because the build has to
 * be two builds:
 *
 *   - **Unsigned**, which is what `npm run dist` has always produced and what
 *     anyone can run without an Apple account. macOS then asks for
 *     right-click → Open on first launch, once, per machine.
 *   - **Signed and notarised**, which is the only thing that makes that prompt
 *     go away for someone who downloaded the DMG. It needs a paid Apple
 *     Developer account and a *Developer ID Application* certificate; there is
 *     no free path to it, and an ad-hoc signature does not count.
 *
 * Which one you get is decided by the environment, so neither build needs a
 * different command or a different file to be edited:
 *
 *   APPLE_TEAM_ID=XXXXXXXXXX \
 *   APPLE_ID=you@example.com \
 *   APPLE_APP_SPECIFIC_PASSWORD=abcd-efgh-ijkl-mnop \
 *   npm run dist
 *
 * With none of those set the result is exactly the unsigned DMG as before.
 */

const teamId = process.env.APPLE_TEAM_ID;
const appleId = process.env.APPLE_ID;
const applePassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;

// Signing needs the certificate; notarising needs an Apple ID on top of it, so
// the two are decided separately. Signing without notarising is still useful —
// it is what a self-distributed build inside one team looks like.
const signing = Boolean(teamId);
const notarising = signing && Boolean(appleId && applePassword);

if (signing) {
  console.log(
    `[build] signing for team ${teamId}${notarising ? ' and notarising' : ' (not notarising: APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD unset)'}`,
  );
} else {
  console.log('[build] unsigned build — first launch will need right-click → Open');
}

module.exports = {
  appId: 'com.kubrik.smart-terminal',
  productName: 'Smart Terminal',
  directories: {
    output: 'release',
    buildResources: 'resources',
  },
  files: ['dist/**', 'electron/**', 'package.json'],
  // node-pty is native; the MCP server has to be a real file on disk because the
  // Claude CLI spawns it as a plain-node child, and plain node cannot read an asar.
  asarUnpack: ['**/node_modules/node-pty/**', 'electron/group-mcp.js'],
  mac: {
    target: [
      { target: 'dmg', arch: ['arm64'] },
      { target: 'dir', arch: ['arm64'] },
    ],
    category: 'public.app-category.developer-tools',
    icon: 'resources/icon.icns',
    darkModeSupport: true,
    // The hardened runtime is a precondition of notarisation and a nuisance
    // without it, so it follows the certificate.
    hardenedRuntime: signing,
    gatekeeperAssess: false,
    // `null` means "do not sign at all". Anything else lets electron-builder
    // pick the Developer ID certificate out of the keychain itself.
    identity: signing ? undefined : null,
    ...(signing
      ? {
          entitlements: 'resources/entitlements.mac.plist',
          entitlementsInherit: 'resources/entitlements.mac.plist',
        }
      : {}),
    ...(notarising ? { notarize: { teamId } } : {}),
  },
  dmg: {
    title: 'Smart Terminal',
  },
};
