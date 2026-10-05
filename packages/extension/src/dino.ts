/**
 * The dinosaur g-code wears, named once. The build copies its activity-bar mask and 128px icon to the
 * `dist/dino/` paths package.json points at, so switching to another variant is this one line. The chat panel draws
 * Noodle from the sprite table in src/chat/sprite.ts, whose standing frame is this avatar.
 */
export const DINO = 'media/noodle-box-a';

export const DINO_FILES = { mono: `${DINO}-mono.svg`, avatar: `${DINO}-avatar.svg`, icon: `${DINO}-128.png` } as const;

/** Where the build puts the files package.json names. */
export const DINO_DIST = { mono: 'dist/dino/mono.svg', icon: 'dist/dino/icon.png' } as const;
