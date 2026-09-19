#!/bin/bash
# Optional native iPad UI backend. Downloaded sources and build products stay local.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [[ -f ipad_app/.signing.env ]]; then source ipad_app/.signing.env; fi
: "${DEVELOPMENT_TEAM:?Set DEVELOPMENT_TEAM or configure ipad_app/.signing.env}"
: "${WDA_DEVICE_ID:?Set WDA_DEVICE_ID to the paired iPad UDID}"
: "${WDA_BUNDLE_ID:?Set WDA_BUNDLE_ID to a unique personal bundle ID}"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
version=16.12.8
state=control_server/.state/wda
mkdir -p "$state"
if [[ ! -d "$state/package" ]]; then
  npm pack "appium-webdriveragent@$version" --pack-destination "$state" --silent
  tar -xzf "$state/appium-webdriveragent-$version.tgz" -C "$state"
fi
node -e 'if(require("./"+process.argv[1]+"/package/package.json").version!==process.argv[2])throw Error("Unexpected WDA version; move aside the local WDA directory before setup")' "$state" "$version"
args=(-project "$state/package/WebDriverAgent.xcodeproj" -scheme WebDriverAgentRunner
  -destination "id=$WDA_DEVICE_ID" -derivedDataPath "$state/build" -allowProvisioningUpdates
  "DEVELOPMENT_TEAM=$DEVELOPMENT_TEAM" "PRODUCT_BUNDLE_IDENTIFIER=$WDA_BUNDLE_ID" CODE_SIGN_STYLE=Automatic)
xcodebuild build-for-testing "${args[@]}"
echo 'Approve Enable UI Automation with Touch ID on the iPad if prompted.'
echo 'Keep this process running. Copy ServerURLHere from the log into WDA_URL in control_server/.env, then restart MCP.'
exec xcodebuild test-without-building "${args[@]}"
