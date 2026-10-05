/** The question card fixture: prompts and the fake model's ask_user calls, shared by the suite and the test that launches it. */

export const PROMPTS = { keyboard: 'Style the buttons.', clicks: 'Pick a size.', cancel: 'One more question.' } as const;

/** Three questions: a single-select with previews and a recommendation, a multi-select, and a single-select. */
export const THREE = {
  questions: [
    {
      id: 'button',
      header: 'Button',
      question: 'Which button style should the toolbar use?',
      options: [
        { label: 'Solid', description: 'A filled button with white text.', recommended: true, preview: '```css\n.toolbar .button {\n  background: #171717;\n  color: white;\n}\n```' },
        { label: 'Ghost', description: 'Text only until the pointer is over it.', preview: '```css\n.toolbar .button {\n  background: transparent;\n  border: none;\n}\n```' },
      ],
    },
    {
      id: 'targets',
      header: 'Targets',
      question: 'Which platforms should get the new toolbar?',
      multiSelect: true,
      options: [
        { label: 'Web', description: 'The browser build.' },
        { label: 'Desktop', description: 'The Electron build.' },
        { label: 'Mobile', description: 'The React Native build.' },
      ],
    },
    {
      id: 'layout',
      header: 'Layout',
      question: 'Where should the toolbar sit?',
      options: [
        { label: 'Top', description: 'Above the editor, full width.' },
        { label: 'Side', description: 'A narrow column on the left.' },
      ],
    },
  ],
} as const;

export const THREE_RESULT = [
  'The user answered:',
  '- Button (Which button style should the toolbar use?): Ghost',
  '- Targets (Which platforms should get the new toolbar?): Web, Mobile, "a CLI" (in their own words)',
  '- Layout (Where should the toolbar sit?): Side',
].join('\n');

export const TWO = {
  questions: [
    {
      id: 'size',
      header: 'Size',
      question: 'How large should the buttons be?',
      options: [
        { label: 'Small', description: '24 pixels high.' },
        { label: 'Medium', description: '32 pixels high.', recommended: true },
      ],
    },
    {
      id: 'extras',
      header: 'Extras',
      question: 'Anything else for the toolbar?',
      multiSelect: true,
      options: [
        { label: 'Tooltips', description: 'A label on hover.' },
        { label: 'Shortcuts', description: 'Show the key next to the label.' },
      ],
    },
  ],
} as const;

export const TWO_RESULT = ['The user answered:', '- Size (How large should the buttons be?): Medium', '- Extras (Anything else for the toolbar?): "Dark mode" (in their own words)'].join('\n');

export const ONE = {
  questions: [{ id: 'name', header: 'Name', question: 'What should the toolbar be called?', options: [{ label: 'Toolbar', description: 'The plain name.' }, { label: 'Action bar', description: 'As in Material.' }] }],
} as const;

export const ANSWERS = { keyboard: 'Ghost buttons on the side, for web, mobile and a CLI.', clicks: 'Medium, with dark mode.', cancel: 'I will call it Toolbar.' } as const;

export const THEMES = { dark: 'Default Dark Modern', light: 'Default Light Modern', 'high-contrast': 'Default High Contrast' } as const;
