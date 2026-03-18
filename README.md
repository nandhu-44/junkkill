# junkkill

[![npm version](https://img.shields.io/npm/v/junkkill?style=flat-square&logo=npm)](https://www.npmjs.com/package/junkkill)
[![npm downloads](https://img.shields.io/npm/dm/junkkill?style=flat-square&logo=npm)](https://www.npmjs.com/package/junkkill)
[![node](https://img.shields.io/node/v/junkkill?style=flat-square&logo=node.js)](https://www.npmjs.com/package/junkkill)
[![license](https://img.shields.io/npm/l/junkkill?style=flat-square)](https://github.com/nandhu-44/junkkill/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/nandhu-44/junkkill?style=flat-square)](https://github.com/nandhu-44/junkkill/stargazers)

Safe, interactive junk cleaner for development folders.

`junkkill` scans a directory tree for heavy targets (like `node_modules`, `venv`, cache folders, and large files), then deletes only what you explicitly choose.

## npm Package

Published name: `junkkill`

## Features

- Interactive selection by index or range (`1,4-7`)
- Quick select everything using `all`
- Large file scanning with configurable threshold
- Colorized terminal output with step-by-step flow
- JSON mode for scripting and automation
- Dry-run mode to preview deletion safely

## Safety

- Only items found in the current scan can be selected
- Every selected path is revalidated before deletion
- Deletion is blocked for scan root and protected system paths
- Symbolic links are blocked
- Double confirmation before delete (`DELETE` and `y/N`, unless `--yes`)

## Install

```bash
# global install
npm install -g junkkill

# or run directly without install
npx junkkill --help
```

## Quick Start

```bash
# scan current directory
junkkill

# custom thresholds
junkkill --min-dir-mb 20 --min-file-mb 20

# custom root
junkkill --root "/home/user/workspace"

# safe preview
junkkill --dry-run
```

## Selection Input

At the selection prompt, you can enter:

- `3` for a single item
- `1,4,8` for multiple items
- `2-6` for a range
- `1,3-5,9` for mixed selection
- `all` to select every listed result

Leave input empty to cancel without deleting.

## CLI Options

```text
-d, --root <path>        Root directory to scan (default: current directory)
--min-dir-mb <n>         Minimum size for target directories (default: 100)
--min-file-mb <n>        Minimum size for large files (default: 100)
--targets <csv>          Comma-separated target directory names
--exclude <csv>          Comma-separated directory names to skip while scanning
--no-files               Disable large file scanning
--max-results <n>        Limit number of listed results (default: 1000)
--dry-run                Simulate deletion without removing anything
-y, --yes                Skip final y/N confirmation (still asks for DELETE)
--json                   Print scan output as JSON and exit
-h, --help               Show help
```

## Examples

```bash
# JSON output for scripts
junkkill --json

# scan only selected target names
junkkill --targets "node_modules,.venv,venv,__pycache__,dist"

# skip specific directories
junkkill --exclude ".git,.idea,archive"

# lower thresholds for small test projects
junkkill --min-dir-mb 0.01 --min-file-mb 0.001 --dry-run
```

## License

MIT
