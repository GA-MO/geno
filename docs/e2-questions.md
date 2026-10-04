# E2 questions: is grep enough?

Ten "where and how is X done" questions for `gcode ask`, five per repo. Each answer was found by reading the code by hand, and cites file and line. The coordinator grades the `gcode ask` transcripts against these answers. The transcripts are in `$GCODE_HOME/e2/q01.txt` through `q10.txt`.

Workspaces: `~/Development/next-15-template` (questions 1 to 5) and `~/Development/payload-site-template` (questions 6 to 10).

## next-15-template

### 1. How does a service call decide whether to return mock JSON or call the real API?

`createFetcher` in `src/plugins/createFetcher/index.ts` merges the caller's options over `defaultOptions` (lines 12-18 and 29-32), where `mock` defaults to `true` and `jsonMockup` to `''`. `shouldUseMockup` (lines 20-26) returns true only when `NODE_ENV` is `development`, `mock` is truthy, and `jsonMockup` is not empty. In that case the fetcher GETs `${NEXT_PUBLIC_BASE_PATH}${jsonMockup}` with axios (lines 37-40); otherwise it sends the real request with `axios.request(fetchOptions)` (line 42). The demo services pass `jsonMockup: '/mockup/demo/list.json'` and `'/mockup/demo/create.json'` (`src/services/demo/index.ts` lines 13 and 30), which are files under `public/mockup/demo/`. So in development the demo services always read the mock files, and in production they call `${NEXT_PUBLIC_API_HOST}/api/demo/...`.

### 2. When an API request fails, how is the error shown to the user, and what does the caller get?

The `catch` in `createFetcher` (`src/plugins/createFetcher/index.ts` lines 45-75) builds a `ServiceError` `{ title, message }`. For an axios error the title is `error.response?.statusText ?? 'Error'` and the message is `error.response?.data.message || error.message` (lines 49-51); for any other error it uses the error's `name` and `message` (lines 53-54). If `showErrorDialog` is set, which it is by default (line 17), it opens the Mantine context modal `applicationError` with that title and message (lines 62-72). That modal is registered as `AppErrorModal` in `src/plugins/mantine/provider.tsx` line 12 and renders the title, the message and a Close button (`src/plugins/mantine/modal.tsx` lines 11-26). The promise then rejects with the `ServiceError` (line 74).

### 3. How is the locale for a request chosen, and what happens with an unsupported locale?

The supported locales are `en` and `th`, with `en` the default and `localePrefix: 'as-needed'` (`src/plugins/i18n/routing.ts` lines 3-7), so English URLs carry no prefix. `src/middleware.ts` runs next-intl's `createMiddleware(routing)` (line 4) on `/`, `/(en|th)/...` and every path that is not an API, `_next`, `_vercel` or file path (line 8). In `src/plugins/i18n/request.ts` the request config takes the `[locale]` segment and falls back to `routing.defaultLocale` when it is missing or not in `routing.locales` (lines 6-10), then loads `messages/${locale}.json` (line 14). Separately, `src/app/[locale]/layout.tsx` calls `notFound()` when the `locale` param is not a supported locale (lines 25-27).

### 4. After a demo item is created, how does the demo list refresh, and what does the user see?

`useDemoCreate` in `src/services/demo/index.ts` (lines 35-48) is a React Query mutation whose `onSuccess` invalidates the `['demoList']` query on the shared query client (line 39), which makes `useDemoList` (query key `['demoList']`, lines 18-24) refetch. It then shows a Mantine notification titled "Success" with the message "Your form has been submitted" at the bottom centre (lines 41-45). The shared client comes from `getQueryClient` in `src/plugins/reactQuery/client.ts` (lines 22-34), which returns one cached client in the browser and a new one per call on the server.

### 5. How does createFetcher apply its `delay` option, and in what unit?

The request runs inside `setTimeout(() => callFetch(), fetchOptions.delay || 0 * 1000)` (`src/plugins/createFetcher/index.ts` line 78). Because `*` binds tighter than `||`, this is `delay || 0`: a set delay is used as milliseconds, unconverted, and the `* 1000` only multiplies the zero fallback. The default `delay` is `0` (line 15), so by default the call is deferred to the next macrotask with no wait.

## payload-site-template

### 6. How are uploaded images resized, re-encoded and size-limited?

The `media` collection's `upload` config in `src/collections/Media.ts` (lines 18-34) accepts `image/*` and `video/*` (line 21). The stored original is shrunk to fit inside 1920x1920 without enlarging (line 24) and re-encoded as WebP at quality 75 (line 27). It also generates three WebP sizes at quality 75: `thumbnail` 400x300, `card` 1024 wide and `feature` 1920 wide, all centred (lines 28-32). The `thumbnail` size is the admin thumbnail (line 33). Sharp is wired in `src/payload.config.ts` line 56. Uploads over 20 MB are rejected with "File is larger than the 20MB limit — please upload a smaller file." (`src/payload.config.ts` lines 40-44). Video is stored as is, since the resize and format options only apply to images (comment at `src/collections/Media.ts` lines 19-20).

### 7. How do destructive scripts refuse to run against a production database?

`assertLocalDb` in `scripts/lib/assert-local-db.ts` (lines 8-24) parses the hostname out of `DATABASE_URI` (lines 9-16; an unparseable URI gives an empty host). Unless the host is `localhost` or `127.0.0.1` (line 17), it throws "Refusing to run a destructive script against a non-local database" (lines 19-22). The only override is setting `ALLOW_REMOTE_DB=I_KNOW_WHAT_IM_DOING` (line 18). The doc comment says scripts must call it at the top of `main()` before any `getPayload` or database call (line 6).

### 8. How does CI block a destructive database migration, and how is a reviewed one let through?

`scripts/check-migrations.ts` reads every `.ts` file in `src/migrations` except `index.ts` (lines 20 and 32-34). For each, it takes the source from `export async function up` up to `export async function down` (`upBody`, lines 24-29) and tests it against `/\bDROP\s+TABLE\b|\bDROP\s+COLUMN\b|\bTRUNCATE\b/i` (line 21). A file whose `up()` matches and that has no `reviewed-destructive:` comment anywhere (lines 22 and 35) is an offender; the script prints the offenders with advice and exits 1 (lines 38-48). Only `up()` is scanned because a `down()` legitimately drops what `up()` created (lines 10-11). A reviewed destructive migration passes by adding `// reviewed-destructive: <why this is safe>` to the file (lines 7-8).

### 9. How are the CMS manual's screenshots served, and how are access and path traversal handled?

The route `src/app/(payload)/admin/manual-assets/[name]/route.ts` serves them. Its `GET` (lines 19-36) authenticates the request with `payload.auth({ headers })` and returns 401 without a user (lines 20-22). It allows only the extensions in `CONTENT_TYPES` (png, jpg, jpeg, gif, webp, svg; lines 8-15) and returns 404 for any other (lines 25-26). It reads the file with `readManualImage` and responds with `Cache-Control: private, max-age=3600` (lines 29-31), or 404 if the read fails (lines 33-35). `readManualImage` in `src/lib/manual.ts` (lines 39-40) reads `docs/cms-manual/images/<path.basename(name)>` under `process.cwd()` (line 28), so the `basename` strips any directory part and blocks traversal.

### 10. Why are media URLs turned into relative paths before they are rendered, and where does that happen?

`toMediaPath` in `src/lib/media.ts` (lines 8-12) returns a URL that already starts with `/` unchanged and otherwise keeps only its pathname and query string. The comment at lines 5-7 gives the reason: Payload prefixes upload URLs with the server URL, so they are absolute, and next/image refuses to fetch absolute URLs that resolve to a loopback or private IP (an SSRF guard), while it serves same-origin paths directly. `mediaUrl` (lines 14-21) and `mediaImage` (lines 35-46) both pass the chosen URL through it (lines 20 and 45), picking the requested size's rendition and falling back to the original upload.
