About the files here: I don't know if they are still useful, or maintained.

Get in touch if you know a file is useful / know it is not.

For e.g. scripst in governance/ if they are still useful, they should be probably be refactored into something easy to use (right now the code is not super clean, the directory is a bit hidden, etc -- it should be part of eg parrot).

# Questions:
## Hoisting 
this is currently in the documentation:

```
## `nmHoistingLimits: workspaces`
By default, Yarn hoists dependencies to the highest possible level. However, Hardhat only allows local installs and thus does not support hoisting: https://hardhat.org/errors/#HH12 .

In Yarn 1 (and Lerna) one can prevent hoisting of specific packages, but that's not possible with Yarn 2. We have therefore disabled hoisting past workspaces, i.e., dependencies are always installed in the local `node_modules` folder.
```

Should we change that setting?


## updateadr
the github job updateadr.yml should be updated -- I'm actually not sure we should keep this workflow since mangrove.js releases could totally trail mangrove-solidity deployments?