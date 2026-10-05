export const FILES = {
  'notes.md': '# Colors\n\nThe flag is red on the left and blue on the right.\n',
  'app.bin': '\0\0binary\0',
} as const;

export const IMAGES = { flag: 'flag.png', big: 'big.png', shot: 'shot.png' } as const;

export const PROMPT = 'What colors are in the flag, and what does shot.png show?';

export const ANSWER = [
  'The flag is red on the left and blue on the right. Here is the shot from the workspace:',
  '',
  '![the shot](shot.png)',
  '',
  'A remote image stays a link: ![pixel](https://example.com/pixel.png)',
].join('\n');
