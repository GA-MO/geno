# A21-outside-workspace, run sonnet-1

Mode: non-interactive. Fixture: `monorepo`. Model: claude-sonnet-5-5.

## User

Is our tsconfig.json stricter or looser than the shared base config? Tell me which options differ.

- `glob` `{"pattern":"tsconfig*.json"}` -> **ok**

  ```
  tsconfig.json
  ```

- `read` `{"path":"tsconfig.json"}` -> **ok**

  ```
  1	{
  2	  "compilerOptions": {
  3	    "target": "ES2022",
  4	    "module": "NodeNext",
  5	    "strict": true
  6	  }
  7	}
  ```

- `grep` `{"pattern":"tsconfig|extends","ignore_case":true}` -> **ok**

  ```
  no matches
  ```

**Geno:** I can't compare them, because I found no shared base config to compare against.

`tsconfig.json` is the only tsconfig in the repo. It has no `extends` field, and nothing else in the workspace mentions a base config. It sets only three options:

- `target`: `ES2022`
- `module`: `NodeNext`
- `strict`: `true`

If the base is a package such as `@tsconfig/node-xx` or `@company/tsconfig`, it isn't installed here. It could also be a file outside the workspace, which I can't read. Tell me its name, or put a copy in the workspace, and I'll list the differing options.

`strict: true` already turns on the whole strict family, so this config is unlikely to be looser than a typical base on those flags. Options the base may set beyond strict are a different matter. Examples are `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `noImplicitOverride`. This file doesn't set any of them.
