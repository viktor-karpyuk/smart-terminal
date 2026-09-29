# Writing and publishing an extension

An extension is a folder with an `extension.json` in it. It can bring **file
previews** (a function that turns a file's text into HTML) and **views** (an HTML
page that works in its own panel). `example/` is a complete one.

## Where its code runs

- A preview's `render(input)` runs in a worker with no DOM, no filesystem and,
  for any extension that does not ship with the app, no network. It is given the
  file's text and returns a string, which is shown in a frame that runs no scripts.
- A view is its own document, in a sandboxed frame that cannot reach the network.
  It talks to the app only through `host.call(name, args)`, and every call is
  checked against the permissions in its `extension.json`.

## Permissions

An extension from outside the app may only make calls it declared. The person
installing it reads this list first, in these words:

| Permission | What it lets the extension do |
| --- | --- |
| `git.read` | Read the repository open in its panel: history, branches, changes |
| `git.write` | Change that repository: commit, push, pull, switch and delete branches |
| `kube.read` | Read your Kubernetes clusters: resources, logs, events |
| `kube.write` | Change your clusters: delete, scale, restart, apply, forward ports |
| `helm.read` | Read Helm releases and their values |
| `helm.write` | Roll back or uninstall Helm releases |
| `build` | Read Maven and Gradle projects |
| `spring` | Run and stop Spring Boot applications |
| `review` | Use the Code Reviewer: pull requests, findings, comments, merges |
| `teams` | Change the Teams connection's settings |
| `deliver` | Send messages to people in Teams, in its own name |
| `terminal` | Open terminals and Claude sessions about what it shows |

Ask for the fewest that work. A call the extension did not declare is refused
with a message that names the missing permission, so it shows up the first time
you try it.

## Trying it locally

Copy the folder into `~/Library/Application Support/Smart Terminal/extensions/`
(or install straight from your repository: Extensions → **From a repository…**),
then install it from the Extensions tab.

## Publishing

1. Push it to a public GitHub repository, `extension.json` at the top or in a
   folder you will name in `path`.
2. Tag a release. Note the commit the tag points at.
3. Open a pull request on the registry,
   [smart-terminal-extensions](https://github.com/viktor-karpyuk/smart-terminal-extensions),
   adding an entry for that commit. Its README has the format.

The registry's check downloads that exact commit and makes sure its
`extension.json` says the same id, version and permissions as the entry. A person
reads the code before merging. Once merged it appears under **Published** for
everybody, and installs that commit and no other.

To publish an update, change `version` and `commit` in the same entry. Anyone
who has it installed sees **Update**, and is shown any new permission first.

## Installing without the registry

**From a repository…** takes any public GitHub repository (optionally
`@tag`). It resolves what you asked for to one commit, shows you who wrote it and
what it asks for, and says plainly that nobody reviewed it. Use it for your own
extensions and for ones you already trust.
