# Development

This document describes local development and the automated build and release workflows for Bitfroest.fs.

## Prerequisites

- Node.js and npm. CI uses Node.js 24.22.2.
- Visual Studio Code 1.100 or later within the version range declared in `package.json`.
- A compatible prebuilt `native/binding.node` for launching the development extension. CI builds this module from pinned sources for each target.

Install the locked JavaScript dependencies with:

```sh
npm ci
```

## Run the extension

Open the repository in Visual Studio Code and start the **Bitfroest.fs: Automatisch neu laden** launch configuration. The configuration starts an Extension Development Host and loads the companion development extension.

On Windows, `Start-Development.ps1` launches the same development setup. It accepts an optional path or command name for the VS Code executable:

```powershell
./Start-Development.ps1 -CodeCommand code
```

## Native build requirements

The native build is defined in `native/CMakeLists.txt`. It requires CMake 3.21 or later, a C++17 compiler, Node-API headers and the pinned libgit2 source tree. The module targets Node-API version 8. Build output must use a separate directory.

CMake accepts `NODE_INCLUDE_DIR` and `LIBGIT2_SOURCE_DIR`. Windows additionally requires `NODE_LIBRARY` pointing to the matching `node.lib`. Linux requires the GLib development SDK; `GLIB_SDK_ROOT` can identify a preinstalled SDK prefix. The build validates the libgit2 version, commit, tree digest and absence of local changes.

`scripts/ci-native-build.cjs` records the automated build sequence and pinned downloads. It expects the matching `BUILD_TARGET` and workflow environment, including `RUNNER_TEMP` and `GITHUB_ENV` on Windows. It copies the resulting module to `native/binding.node`. Native builds and SDK downloads run on development or CI systems; installed extension packages contain the prebuilt module and do not compile it at runtime.

## Checks and tests

Run the repository checks and linter with:

```sh
npm run check
npm run lint
```

`npm run check` runs progress, operation, icon and ZIP checks, followed by JavaScript syntax checks. The icon check includes focused icon tests. `npm run lint` runs ESLint with warnings treated as errors.

Run all Node.js tests with:

```sh
npm test
```

Useful focused commands include:

| Command | Scope |
| --- | --- |
| `npm run test:architecture` | Runtime architecture and icon architecture tests |
| `npm run test:native` | Native and transfer tests for Windows |
| `npm run test:native:linux` | Native and portable-operation tests for Linux |
| `npm run coverage` | Tests with configured coverage thresholds and reports under `coverage/` |

The build workflow runs syntax and lint checks, architecture and release-policy tests, target-specific tests, and native API tests in Electron. Platform results apply to the target tested by that workflow.

During development, run the tests affected by the change. The full suite does not replace target-specific native validation or verification of the relevant user interaction.

## Contribution guidelines

- Use stable, public Visual Studio Code APIs and documented commands for product features. Keep operating system adapters separate from the file model and user interface.
- Add configurable behavior through the native Settings editor. Localize descriptions and choices in English and German; keep setting identifiers stable.
- For new features and bug fixes, add a behavior-focused test before implementation. Use the existing headless unit-test harnesses for interface behavior.
- Native modules are built in advance for supported operating systems and processor architectures. Do not add customer-side compilers, runtime native builds, or external script adapters as product dependencies.
- State platform support only for platforms covered by relevant checks and validation. Keep limitations and unverified behavior explicit.

## Preview the webview

Start the local preview server with:

```sh
npm run preview
```

The server binds to `127.0.0.1` on port `4173` by default. Set `PROTOTYPE_PORT` to use a different port. The preview serves the extension webview assets for local inspection; it does not start the Visual Studio Code extension host.

## Package a beta

Create a pre-release VSIX with:

```sh
npm run package:beta -- --out /absolute/path/bitfroest-fs.vsix
```

The command uses `@vscode/vsce` through `npx`; packaging therefore needs registry access or a suitable local npm cache. Store generated packages outside the source tree.

`npm run publish:beta` publishes a pre-release package through the configured Marketplace publisher account. It requires the appropriate publisher credentials and should be used only for an intended publication.

## Automated builds and releases

GitHub Actions builds Windows x64 and Linux x64 packages. The jobs install locked dependencies, build the native module from pinned sources, run checks and platform tests, verify Electron compatibility, package the target-specific VSIX and validate the isolated package. Linux builds install the GLib development SDK. Successful build artifacts are retained for 14 days.

An experimental macOS ARM64 build is also attempted in CI. Its artifact is not an official supported release.

Pushing a version tag such as `v0.0.40` builds the supported packages and creates a GitHub Release when the required build succeeds. The tag version must match `package.json` and `package-lock.json`. After the GitHub Release succeeds, the workflow publishes the verified package to the Marketplace using its configured trusted identity. A manual workflow run on `main` can publish an existing verified tag by supplying its tag name; leaving the input empty runs builds only.

The workflow does not overwrite an existing GitHub Release. An interrupted release upload may leave a draft for inspection. Marketplace publication is a separate workflow job and depends on release verification.
