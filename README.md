# junkkill

[![npm version](https://img.shields.io/npm/v/junkkill?style=flat-square&logo=npm)](https://www.npmjs.com/package/junkkill)
[![npm downloads](https://img.shields.io/npm/dm/junkkill?style=flat-square&logo=npm)](https://www.npmjs.com/package/junkkill)
[![node](https://img.shields.io/node/v/junkkill?style=flat-square&logo=node.js)](https://www.npmjs.com/package/junkkill)
[![license](https://img.shields.io/npm/l/junkkill?style=flat-square)](https://github.com/nandhu-44/junkkill/blob/main/LICENSE)

Find the heavy stuff your projects leave behind (`node_modules`, virtualenvs, Rust and Gradle build output, caches, multi-GB videos and model files) and delete it from a fast, keyboard-driven list.

```
  junkkill  v0.1.0   ✓ 6,576 folders in 0.2s
 ~/code
 reclaimable 677 MB    freed 0 B    found 6

    PATH                                     TYPE         MODIFIED     SIZE ▾
 ❯  media/movie.mp4                          video          2mo ago     150 MB
  ● webapp/node_modules                      node           3mo ago     124 MB
    api/.venv                                python          1y ago     124 MB
    old-site/node_modules                    node            2y ago     124 MB
    tools/rusty/target                       rust           5d ago     30.0 MB

 1 selected · 124 MB   ↑↓ move  space select  enter delete  q quit  a all  s sort  / filter
```

- **Fast.** Scans on worker threads, one per core, using blocking filesystem calls, so results show up while the scan is still running.
- **Zero dependencies.** Plain Node.js 18+, nothing to install but the package itself.
- **Knows the ecosystems.** Node, Python, Rust, Maven, Gradle, .NET, CMake, Zig, Haskell, Elixir, Dart, CocoaPods, Xcode, Terraform and more. Generic names such as `target`, `build` and `bin` only count when the matching project file is next to them (`Cargo.toml`, `build.gradle`, `*.csproj`, …).
- **Finds big loose files too**, labelled by kind: video, archive, disk image, model weights, datasets, logs, dumps.
- **Safe.** Only scanned items can be deleted, and each one is re-checked before removal: it must still exist, sit inside the scanned folder and not be a symlink. Folders marked `!` (such as `dist` and `build`) are usually regenerable but worth a look first.

## Install

```bash
npm install -g junkkill
# or just run it
npx junkkill
```

## Usage

```bash
junkkill                      # scan the current folder
junkkill ~/code               # scan a specific folder
junkkill --min-dir 100MB      # only folders of 100 MB or more
junkkill --no-files           # junk folders only, skip large files
junkkill -t node_modules      # look only for node_modules
junkkill --dry-run            # try it out without deleting anything
junkkill --list               # print a table and exit
junkkill --json > junk.json   # machine-readable output
```

### Keys

| Key | Action |
| --- | --- |
| `↑` `↓` / `j` `k` | Move |
| `PgUp` `PgDn` `Home` `End` | Jump |
| `space` | Select or unselect |
| `a` | Select all visible items (press again to clear) |
| `enter` / `d` / `Del` | Delete the selection, or the item under the cursor |
| `s` | Sort by size, age or path |
| `/` | Filter by path |
| `esc` | Clear the selection or filter, otherwise quit |
| `q` | Quit |

### Options

```text
-d, --dir <path>       Folder to scan (default: current folder)
--min-dir <size>       Hide junk folders smaller than this (default: 10MB)
--min-file <size>      Report loose files larger than this (default: 100MB)
--no-files             Only look for junk folders, skip large files
-t, --targets <list>   Only look for these folder names, comma separated
-e, --exclude <list>   Extra folder names to skip, comma separated
-s, --sort <key>       size | age | path (default: size)
--dry-run              Go through the motions without deleting anything
-y, --yes              Delete without asking for confirmation
--list                 Print results as a table and exit
--json                 Print results as JSON and exit
--config <file>        Use a different config file
--init                 Create the config file with default values
--no-color             Disable colors
```

Sizes accept `B`, `KB`, `MB`, `GB` and `TB` (for example `500KB` or `1.5GB`). A bare number means MB.

## Config

Settings live in `~/.config/junkkill/config.json` (`%APPDATA%\junkkill\config.json` on Windows; `$XDG_CONFIG_HOME` and `$JUNKKILL_CONFIG` are respected). The file is optional. Run `junkkill --init` to create one with the defaults:

```json
{
  "minDirSize": "10MB",
  "minFileSize": "100MB",
  "scanFiles": true,
  "sort": "size",
  "confirm": true,
  "targets": [],
  "exclude": []
}
```

Command-line flags override the config file, and the config file overrides the defaults.

`targets` and `exclude` **add to** the built-in lists. Prefix a name with `!` to remove a built-in entry. Names can use `*` and `?` wildcards. A target can be a plain name or an object:

```json
{
  "targets": [
    "checkpoints",
    "*.egg-info",
    "!dist",
    { "name": "data", "when": ["*.ipynb"], "group": "dataset", "risky": true }
  ],
  "exclude": ["archive", "!.hg"]
}
```

| Target field | Meaning |
| --- | --- |
| `name` | Folder name, wildcards allowed |
| `when` | Only match if one of these files sits next to the folder |
| `group` | Label shown in the TYPE column |
| `risky` | Show the `!` marker and a warning when deleting |

Your targets are checked before the built-in ones, so an entry such as `{ "name": "build" }` replaces the built-in rule for `build`.

Optional extras: `threads` (number of scan workers, default: CPU cores, max 8).

## License

MIT
