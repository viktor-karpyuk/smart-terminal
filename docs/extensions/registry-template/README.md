# Smart Terminal extensions

The list of extensions anybody can install from inside Smart Terminal
(Extensions → Published).

Every entry pins **one commit** of the author's repository. Smart Terminal
installs exactly that commit, and refuses it if the `extension.json` in it does
not have the same id, version and permissions as the entry. So what was reviewed
here is what people get, and it cannot be swapped afterwards.

## Publishing an extension

1. Put your extension in a public GitHub repository, with `extension.json` at
   the top (or in a folder, and name it in `path`).
2. Tag a release, and copy the commit hash it points at.
3. Open a pull request adding your entry to `index.json`:

```json
{
  "id": "my-extension",
  "name": "My Extension",
  "version": "1.0.0",
  "summary": "One line on what it does.",
  "author": "Your Name",
  "repo": "https://github.com/you/my-extension",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "permissions": ["git.read"]
}
```

The check on the pull request downloads that commit and compares it with your
entry. A person then reads the code at that commit before merging.

## Publishing an update

Open a pull request that changes `version` and `commit` (and `permissions`, if
they changed). People who installed it see **Update**, and are shown any
permission the new version adds before it is installed.

## What reviewers look for

- The code does what the summary says, and nothing else.
- Every permission is used, and none is broader than it needs.
- No obfuscated or minified code without its source in the same repository.
- A view does not try to talk anyone into typing secrets into it.
