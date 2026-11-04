# Bitfroest.fs

[![Marketplace version](https://vsmarketplacebadges.dev/version/bitfroest.bitfroest-fs-prototype.svg)](https://marketplace.visualstudio.com/items?itemName=bitfroest.bitfroest-fs-prototype)
[![Marketplace downloads](https://vsmarketplacebadges.dev/downloads/bitfroest.bitfroest-fs-prototype.svg)](https://marketplace.visualstudio.com/items?itemName=bitfroest.bitfroest-fs-prototype)
[![Marketplace installs](https://vsmarketplacebadges.dev/installs/bitfroest.bitfroest-fs-prototype.svg)](https://marketplace.visualstudio.com/items?itemName=bitfroest.bitfroest-fs-prototype)
[![Build: main](https://github.com/s-a/Bitfroest.fs/actions/workflows/release.yml/badge.svg?branch=main)](https://github.com/s-a/Bitfroest.fs/actions/workflows/release.yml?query=branch%3Amain)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**A two-panel file manager inside Visual Studio Code.** Keep two folders in view, organize project files, and check local Git status without leaving the editor.

![Bitfroest.fs with two folders, native Windows icons and file colors](media/marketplace/showcases/0001-windows-en-dark-main-overview.png)

Bitfroest.fs is for developers managing source and build folders, administrators working with configuration files, and anyone who wants a keyboard-driven way to handle files from Visual Studio Code.

**Beta version** — This extension is under development and may contain bugs or incomplete features.

## What you can do

- Browse two folders side by side, each with its own folder tabs and navigation history.
- Copy, move, rename and delete files, and create folders, with conflict choices and operation progress.
- Search for files and duplicates, and inspect text, binary and hexadecimal content.
- Browse ZIP archives and use supported archive operations.
- View local Git status, configure columns and file colors, and save favorite locations.
- Open a file or folder's Git log with a commit graph, compact commit message and a larger list of changed files. Double-click a changed file to compare its committed versions in the VS Code diff editor.
- Customize shortcuts and settings, with interface text in English or German.

On Windows, the Git file menu also offers **Delete (Keep Local)** and **Delete and Add to Ignore List**. Both keep the local file and stage its removal from Git; the second action adds an exact rule to the `.gitignore` beside the file. Neither action creates a commit. Index changes that would discard staged-only content are refused.

## Get started

Requires Visual Studio Code 1.100.0 or later within the declared compatible version range. Install the pre-release package for your supported operating system and processor. In Visual Studio Code, run **Bitfroest.fs: Show/hide file manager** from the Command Palette, or select its folder button in the Status Bar. Open a source folder in one panel and a destination folder in the other.

The default shortcut is `Ctrl+Alt+Shift+F12` on Windows and Linux. The file manager opens in a separate compact editor window. Run the command again to close it. Existing startup folders are used when available; otherwise, both panels open the existing user home folder. No folders are created when the file manager opens.

## Common shortcuts

| Shortcut | Action |
| --- | --- |
| F2 / Shift+F6 | Rename the selected entry |
| F3 / F4 | View / edit the selected file |
| F5 / F6 | Copy / move the selection |
| F7 | Create a folder |
| F8 | Delete using the configured deletion mode |
| Ctrl+L | Edit the active folder path |
| Ctrl+T / Ctrl+W | Open / close a folder tab |
| Alt+Left / Alt+Right | Navigate backward / forward |
| Alt+F7 | Search for files |

Shortcuts apply in the file manager view. Text fields and ordinary code editors keep their own key bindings. Open **Settings → Keyboard shortcuts** in the file manager to change bindings. Local conflicts must be resolved before saving; external bindings and operating system shortcuts are not checked, and chords are not supported.

<!-- showcase-gallery:start -->
## Feature walkthrough

Windows examples with sample project files. Animations include a pointer highlight and keystroke hints. Drag-and-drop demonstrations stop at the confirmation dialog.

<details>
<summary>0002 · Copy a folder path</summary>

Right-click the address bar and observe the actual clipboard confirmation.

![Copy a folder path](media/marketplace/showcases/0002-windows-en-dark-path-copy-gesture.gif)

</details>

<details>
<summary>0003 · Select files with the right mouse button</summary>

Draw a selection with the right mouse button held down.

![Select files with the right mouse button](media/marketplace/showcases/0003-windows-en-dark-right-selection-gesture.gif)

</details>

<details>
<summary>0004 · Drag a selection with the right button held</summary>

Hold the right mouse button and drag selected files to a destination folder; review the move confirmation.

![Drag a selection with the right button held](media/marketplace/showcases/0004-windows-en-dark-right-drag-gesture.gif)

</details>

<details>
<summary>0005 · Focus the address bar with Ctrl+L</summary>

Press Ctrl+L and edit the selected path in the active address bar.

![Focus the address bar with Ctrl+L](media/marketplace/showcases/0005-windows-en-dark-shortcut-ctrl-l-gesture.gif)

</details>

<details>
<summary>0006 · Commands organized by task</summary>

Discover file actions, selection tools, navigation, view options, configuration and help.

![Commands organized by task](media/marketplace/showcases/0006-windows-en-dark-main-menus-files.png)

![Commands organized by task](media/marketplace/showcases/0007-windows-en-dark-main-menus-selection.png)

![Commands organized by task](media/marketplace/showcases/0008-windows-en-dark-main-menus-commands.png)

![Commands organized by task](media/marketplace/showcases/0009-windows-en-dark-main-menus-view.png)

![Commands organized by task](media/marketplace/showcases/0010-windows-en-dark-main-menus-configuration.png)

![Commands organized by task](media/marketplace/showcases/0011-windows-en-dark-main-menus-help.png)

</details>

<details>
<summary>0012 · Choose a favorite location</summary>

Browse favorite project folders from the location menu.

![Favorite locations containing only sample project folders](media/marketplace/showcases/0012-windows-en-dark-location-menu-favorites.png)

</details>

<details>
<summary>0013 · Select files by pattern</summary>

Enter file masks or regular expressions without applying a selection.

![Select files by pattern](media/marketplace/showcases/0013-windows-en-dark-select-group-dialog.png)

</details>

<details>
<summary>0014 · Remove a group from the selection</summary>

Specify the file pattern to remove from the current selection.

![Remove a group from the selection](media/marketplace/showcases/0014-windows-en-dark-unselect-group-dialog.png)

</details>

<details>
<summary>0015 · Create a folder</summary>

Inspect the folder name and destination before creating anything.

![Create a folder](media/marketplace/showcases/0015-windows-en-dark-new-folder-dialog.png)

</details>

<details>
<summary>0016 · Create a text file</summary>

Inspect the new text-file dialog without creating a file.

![Create a text file](media/marketplace/showcases/0016-windows-en-dark-new-file-dialog.png)

</details>

<details>
<summary>0017 · Copy files</summary>

Review the destination, overwrite policy and verification options before copying.

![Copy files](media/marketplace/showcases/0017-windows-en-dark-copy-dialog.png)

</details>

<details>
<summary>0018 · Move files</summary>

Review the destination and transfer options before moving files.

![Move files](media/marketplace/showcases/0018-windows-en-dark-move-dialog.png)

</details>

<details>
<summary>0019 · Rename a single entry</summary>

Edit the filename in the file list without committing the rename.

![Rename a single entry](media/marketplace/showcases/0019-windows-en-dark-rename-inline-editor.png)

</details>

<details>
<summary>0020 · Preview multiple filenames</summary>

Inspect naming masks, counters and replacement rules before applying changes.

![Preview multiple filenames](media/marketplace/showcases/0020-windows-en-dark-rename-multiple-dialog.png)

</details>

<details>
<summary>0021 · Review a recycle-bin deletion</summary>

Inspect the confirmation for moving selected entries to the recycle bin.

![Review a recycle-bin deletion](media/marketplace/showcases/0021-windows-en-dark-delete-trash-confirmation.png)

</details>

<details>
<summary>0022 · Review permanent deletion</summary>

Inspect the permanent-deletion warning without confirming it.

![Review permanent deletion](media/marketplace/showcases/0022-windows-en-dark-delete-permanently-confirmation.png)

</details>

<details>
<summary>0023 · Find files</summary>

Inspect basic criteria, advanced filters and saved searches before starting a search.

![Find files](media/marketplace/showcases/0023-windows-en-dark-file-search-general.png)

![Find files](media/marketplace/showcases/0024-windows-en-dark-file-search-advanced.png)

![Find files](media/marketplace/showcases/0025-windows-en-dark-file-search-presets.png)

</details>

<details>
<summary>0026 · Keep a search window open</summary>

Open the nonmodal search variant alongside the file manager.

![Keep a search window open](media/marketplace/showcases/0026-windows-en-dark-file-search-separate-dialog.png)

</details>

<details>
<summary>0027 · Inspect file contents</summary>

View a real file in text, binary, hexadecimal, HTML-text, Unicode and UTF-8 modes.

![Inspect file contents](media/marketplace/showcases/0027-windows-en-dark-file-viewer-text.png)

![Inspect file contents](media/marketplace/showcases/0028-windows-en-dark-file-viewer-binary.png)

![Inspect file contents](media/marketplace/showcases/0029-windows-en-dark-file-viewer-hex.png)

![Inspect file contents](media/marketplace/showcases/0030-windows-en-dark-file-viewer-html.png)

![Inspect file contents](media/marketplace/showcases/0031-windows-en-dark-file-viewer-unicode.png)

![Inspect file contents](media/marketplace/showcases/0032-windows-en-dark-file-viewer-utf8.png)

![Inspect file contents](media/marketplace/showcases/0033-windows-en-dark-file-viewer-edit-menu.png)

![Inspect file contents](media/marketplace/showcases/0034-windows-en-dark-file-viewer-options-menu.png)

![Inspect file contents](media/marketplace/showcases/0035-windows-en-dark-file-viewer-encoding-menu.png)

</details>

<details>
<summary>0036 · Search inside the viewer</summary>

Inspect text-search, direction and matching options.

![Search inside the viewer](media/marketplace/showcases/0036-windows-en-dark-viewer-search-dialog.png)

</details>

<details>
<summary>0037 · Choose another codepage</summary>

Inspect the codepage input without saving an encoding preference.

![Choose another codepage](media/marketplace/showcases/0037-windows-en-dark-viewer-codepage-dialog.png)

</details>

<details>
<summary>0038 · Prepare a ZIP archive</summary>

Inspect compression, encryption and recursive packing options without creating an archive.

![Prepare a ZIP archive](media/marketplace/showcases/0038-windows-en-dark-archive-pack-dialog.png)

</details>

<details>
<summary>0039 · Prepare ZIP extraction</summary>

Inspect destination and extraction options without writing files.

![Prepare ZIP extraction](media/marketplace/showcases/0039-windows-en-dark-archive-unpack-dialog.png)

</details>

<details>
<summary>0040 · Inspect local Git changes</summary>

Show modified, staged and untracked entries in the demonstration repository.

![Inspect local Git changes](media/marketplace/showcases/0040-windows-en-dark-git-status-overview.png)

</details>

<details>
<summary>0041 · Browse commit history</summary>

Inspect the commit graph, commit message and changed files.

![Browse commit history](media/marketplace/showcases/0041-windows-en-dark-git-history-log.png)

</details>

<details>
<summary>0042 · Compare committed or working versions</summary>

Open the actual VS Code diff editor for a selected Git file.

![Compare committed or working versions](media/marketplace/showcases/0042-windows-en-dark-git-diff-working-tree.png)

</details>

<details>
<summary>0043 · Inspect available local branches</summary>

Open the read-only branch list for the active repository.

![Native Visual Studio Code list of branches from the sample repository](media/marketplace/showcases/0043-windows-en-dark-git-branches-quickpick.png)

</details>

<details>
<summary>0044 · Configure the file manager</summary>

Inspect the native integration entry and extension configuration categories.

![Configure the file manager](media/marketplace/showcases/0044-windows-en-dark-settings-editor.png)

</details>

<details>
<summary>0045 · Configure favorite locations</summary>

Manage favorite locations and groups.

![Configure favorite locations](media/marketplace/showcases/0045-windows-en-dark-settings-favorites-editor.png)

</details>

<details>
<summary>0046 · Configure file-list columns</summary>

Inspect column sets, field choices and column visibility.

![Configure file-list columns](media/marketplace/showcases/0046-windows-en-dark-settings-columns-editor.png)

</details>

<details>
<summary>0047 · Configure keyboard shortcuts</summary>

Inspect commands, editable bindings and conflict information.

![Configure keyboard shortcuts](media/marketplace/showcases/0047-windows-en-dark-settings-shortcuts-editor.png)

</details>

<!-- showcase-gallery:end -->

## Configuration

Search for `Bitfroest` in the Visual Studio Code Settings editor. Options include file operations, columns, favorites, colors, Git status, archive behavior and interface language. Tab layouts can be stored per workspace or shared across workspaces.

File-list columns support dragging, resizing and content-based autosizing. The standard view hides the attributes column; it can be enabled in the column settings. Directory size cells stay empty until a calculated size is available. The standard date column displays time to the minute. The lists use the editor font and existing icon and row sizes.

The copy and move dialog includes **Compare file contents after copying**, disabled by default. The choice is saved as `bitfroest.files.verifyAfterCopy` for subsequent operations. File identity, size and safety checks remain enabled.

## Platform support

| Platform | Support |
| --- | --- |
| Windows | Primary supported platform, including native Windows integrations |
| Linux | Native file copy, Git index actions, supported desktop capabilities and portable file operations; file clipboard access requires X11 with XFixes or Wayland with ext-data-control-v1. The Windows shell context menu is unavailable |
| macOS | Not supported |

Published Windows and Linux packages target x64 processors. Linux packages target Ubuntu 24.04 or a compatible newer runtime.

Native folder icons on Linux require GIO, GdkPixbuf and installed image loaders. SVG icons require the librsvg loader. On Ubuntu, these runtime components are provided by `libglib2.0-0t64`, `libgdk-pixbuf-2.0-0`, `librsvg2-common` and `shared-mime-info`.

Linux file clipboard access uses the current extension host's desktop session and requires `libxcb.so.1` with `libxcb-xfixes.so.0`, or `libwayland-client.so.0` with compositor permission to use `ext-data-control-v1`. Compositors without that optional protocol cannot expose the system file clipboard to the extension host. Internal copy and paste remain available. A completed move is confirmed by the file-operation backend; another application consuming a cut selection does not provide a standardized move-completion notification. Clipboard contents published by the extension remain available while their native session is active.

When an operating system function is unavailable, the file manager reports it in its lower status bar when that function is used. VS Code remote hosts, browser use and processor architectures beyond the published packages are not covered by a general compatibility claim.

## Beta notice

**Use at your own risk.** The software is provided as is, without warranties, to the extent permitted by applicable law. Warranty and liability are governed by the Apache License 2.0, in particular Sections 7 and 8. Mandatory statutory rights remain unaffected.

**Risk of data loss.** File operations modify real data and may cause unintended data loss. Use copies or test data when evaluating this beta. Where possible, work in a Git repository as an additional safety net, with important changes committed before file operations. Git does not protect untracked or ignored files and does not replace a backup. Only use production data if a current backup that can be restored is available. If there is any doubt about the backup, do not use this extension on production data.

## License and support

Licensed under the [Apache License 2.0](LICENSE). Project attribution is recorded in [NOTICE](NOTICE); third-party component licenses are included under `licenses`. Use the [GitHub issue tracker](https://github.com/s-a/Bitfroest.fs/issues) for project support and bug reports.

The **Licenses and acknowledgements** command opens the bundled notices inside Visual Studio Code.

## Contributing

Development setup, checks, and release procedures are documented in [DEVELOPMENT.md](https://github.com/s-a/Bitfroest.fs/blob/HEAD/DEVELOPMENT.md).
