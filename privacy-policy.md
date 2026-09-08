# Privacy Policy

GitHub Show Reviewer Bridge displays review requests and submitted reviews on configured GitHub pull-request lists.

The extension does not request, store, read, log, or transmit GitHub credentials. A local Native Messaging host invokes the already installed GitHub CLI, which uses its existing authentication to contact the explicitly configured GitHub host. The CLI, not the extension, manages that authentication.

Repository identifiers and PR numbers travel through Chrome Native Messaging to the local host. Only reviewer logins, display names, team slugs, review states, request identifiers, and fixed error codes/messages return to the extension. Successful display data is cached in service-worker memory for 45 seconds. There is no telemetry, external analytics, avatar loading, or debug log.

The host does not expose a local network server and does not return raw CLI output or credentials. The installer stores allowed hostnames, the extension origin, and executable paths locally; these are not credentials.

On update/startup, the extension removes the legacy githubToken key from its own Chrome sync and local storage without reading it. An independently installed older extension must be removed separately. Revoke obsolete credentials through GitHub.
