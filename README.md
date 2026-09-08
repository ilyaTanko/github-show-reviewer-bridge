# GitHub Show Reviewer Bridge

See requested reviewers and review decisions directly in your GitHub pull request list.

![Requested reviewers and review status icons in a GitHub pull request list](docs/show_reviewer_list.png)

This fork builds on [github_show_reviewer](https://github.com/araitaiga/github_show_reviewer) by Taiga Arai. Thank you for creating and sharing the original extension.

I created this fork for organizations that prohibit personal access tokens (PATs). It uses your existing GitHub CLI authentication instead of asking you to provide a PAT to the extension.

## 🚀 Get Started

You need **Chrome 120+**, **Node.js 22.18+**, and [GitHub CLI](https://cli.github.com/).

1. Download the production ZIP from [Releases](https://github.com/takara2314/github-show-reviewer-bridge/releases) and extract it. Choose the file **without** `-development` in its name. If no release is available, [build from source](#-build-from-source).
2. Sign in with GitHub CLI. Skip this if you are already signed in:

   ```sh
   gh auth login
   ```

3. Open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**, and choose the extracted `extension` folder.
4. Copy the extension ID shown in Chrome. From the extracted ZIP folder, register the native host:

   ```sh
   node native-host/install.cjs YOUR_EXTENSION_ID --production
   ```

5. Reload the extension, then open a repository's **Pull requests** tab.

**Both loading the extension and running the installer are required.** Chrome reads the extracted folder, so keep it in place. If your extension ID changes, run the installer again with the new ID.

GitHub Enterprise Cloud on `github.com` uses the same steps. For a different hostname, see [Custom GitHub Hosts](#-custom-github-hosts). This fork is installed manually from GitHub Releases, not through the Chrome Web Store.

## ✨ Features

- See requested users, teams, and people or bots who have submitted reviews.
- Read review states at a glance with [Octicons](https://primer.style/octicons/).
- Keep approvals and change requests visible even after later comments.
- Filter pull requests by clicking a reviewer name.
- Use existing GitHub CLI credentials without entering a token in the extension.
- Keep the original PR metadata layout intact with reviewers on a separate line.

## 🛠️ Build from Source

Clone this repository, then install dependencies and create a production package:

```sh
git clone https://github.com/takara2314/github-show-reviewer-bridge.git
cd github-show-reviewer-bridge
npm ci
npm run package
```

Packaging runs type checks and tests, compiles TypeScript to JavaScript, and writes a ZIP to `release/`.

| Output | Purpose |
| --- | --- |
| `dist/extension/` | Compiled extension to load in Chrome |
| `dist/native-host/` | Native host, installer, and host configuration |
| `release/github-show-reviewer-bridge-<version>.zip` | Production package with setup instructions and licenses |

Use `dist/extension`, not the source repository root, with **Load unpacked**. For a local production build, register it with:

```sh
node dist/native-host/install.cjs YOUR_EXTENSION_ID --production
```

Packages do not include TypeScript sources, source maps, `node_modules`, or credentials. Node.js and GitHub CLI must be installed separately.

## 🌐 Custom GitHub Hosts

The default host is `github.com`. To use another host, edit `bridge.config.json` before building:

```json
{
  "hosts": ["github.com", "github.example.internal"]
}
```

Use explicit lowercase hostnames. Wildcards, full URLs, ports, and IP addresses are not supported. Sign in to each host with GitHub CLI:

```sh
gh auth login --hostname github.example.internal
```

After changing the host list, rebuild and reinstall both the extension and native host. GitHub Enterprise Server versions may require adjustments to the GraphQL schema or page selectors.

## 🧑‍💻 Development

Development builds use a separate native host registration and installation directory.

On macOS or Linux:

```sh
BRIDGE_DEVELOPMENT=1 npm run package
```

On PowerShell:

```powershell
$env:BRIDGE_DEVELOPMENT='1'
npm run package
Remove-Item Env:BRIDGE_DEVELOPMENT
```

Load `dist/extension` in Chrome, copy its extension ID, then run:

```sh
node dist/native-host/install.cjs YOUR_EXTENSION_ID --development
```

Reload the extension and PR list after rebuilding. If you change native host code, rerun the installer as well. Development ZIP filenames end in `-development.zip`. To create a production build, leave `BRIDGE_DEVELOPMENT` unset.

Run the checks with:

```sh
npm test
```

Tests include type checking and compilation, request validation, pagination, review decisions, sender validation, caching, native message framing, installation into an isolated home, and UI behavior. They do not use your GitHub credentials or access real repositories.

## ⚙️ Installation Details

The installer supports per-user installation on macOS, Linux, and Windows using Chrome's standard configuration locations. Chromium, Chrome for Testing, and custom user data directories are not supported. Windows registration uses `HKCU`.

If GitHub CLI is outside the standard installation locations, pass its absolute path:

```sh
node native-host/install.cjs YOUR_EXTENSION_ID --production /absolute/path/to/gh
```

The installer records absolute paths for Node.js and GitHub CLI. Rerun it if either executable moves or is removed during an upgrade.

Authentication uses GitHub CLI's normal user configuration and OS credential store. Token environment variables and `GH_CONFIG_DIR` overrides are not used. If your organization blocks unpacked extensions or Native Messaging, ask your administrator about an approved installation method.

## 🔎 Behavior and Troubleshooting

The extension works on repository PR lists at `https://HOST/OWNER/REPO/pulls`. Dashboards, global search results, and individual PR pages are not supported.

Review decisions use the latest approval or change request for each reviewer. Later comments do not replace those decisions. Without an active decision, the latest comment or dismissed review is shown. Reviews submitted by the PR author are excluded. `None` means there are no requested reviewers or displayed reviews.

Hover over a review icon to read its status; screen readers receive the same label. Icons inherit the text color.

| Symptom | What to check |
| --- | --- |
| `gh sign-in required` | Run `gh auth login --hostname HOST` for the configured host. |
| GitHub CLI not found | Reinstall the bridge with the correct absolute path to `gh`. |
| Access denied or PR not found | Check that your CLI account can access the repository. |
| Reviewers unavailable | Check the native host installation, extension ID, and build mode, then select **Retry**. |
| An old review state remains visible | Successful results are cached for 45 seconds. Wait, then reload the PR list. |

Requests batch up to 50 PRs and paginate review history and requests. Each request is limited to 15 seconds, 8 MiB of CLI output, 1 MiB of response data, and 50,000 fetched nodes. Exceeding a limit produces an error rather than a partial result.

GitHub page changes can affect the extension's selectors. Verify your target Enterprise environment and operating system before distributing a build; Windows and Linux still need manual validation.

## 🔐 Privacy and Migration

The extension sends a validated repository and PR list through Chrome Native Messaging. The native host runs a fixed, read-only `gh api graphql` query without a shell. Both sides validate allowed hosts and caller identity. Arbitrary commands, queries, and URLs are rejected.

There is no local server, telemetry, or token input screen. Only reviewer display data is returned to the browser. See the [privacy policy](privacy-policy.md) for details.

When upgrading under the same extension ID, the bridge removes the old `githubToken` storage key without reading it. It cannot access storage belonging to an older installation with a different ID. Remove that installation and revoke any unused tokens on GitHub.

## 🗑️ Uninstall

Remove the extension from Chrome, then delete its native host registration and installation directory.

| Platform | Production registration |
| --- | --- |
| macOS | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.github_show_reviewer.bridge.json` |
| Linux | `~/.config/google-chrome/NativeMessagingHosts/com.github_show_reviewer.bridge.json` |
| Windows | Registry key `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.github_show_reviewer.bridge` |

The host files are stored in:

- macOS/Linux: `~/.local/share/github-show-reviewer-bridge/production`
- Windows: `%LOCALAPPDATA%\GitHubShowReviewerBridge\production`

For development installations, use the registration name ending in `.development` and the `development` directory instead of `production`.

## 📄 License and Credits

This project is a modified fork of [araitaiga/github_show_reviewer](https://github.com/araitaiga/github_show_reviewer), originally created by Taiga Arai. This fork adds the TypeScript implementation and GitHub CLI bridge and is distributed separately from the original Chrome Web Store extension.

Released under the [MIT License](LICENSE), with copyright notices for Taiga Arai and Takara Hamaguchi. Octicons retain their own MIT license; see [Third-party notices](THIRD_PARTY_NOTICES.md).
