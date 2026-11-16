interface Node {
  readonly type: string;
  readonly tagName?: string;
  readonly properties?: Record<string, unknown>;
  readonly children?: readonly Node[];
}

const ATTRIBUTE: Readonly<Record<string, string>> = { a: 'href', img: 'src' };

/** Puts the deploy's base on markdown's site-path links and images, which the pages write as `/start/glossary/`. */
export default function rehypeBase({ base }: { readonly base: string }) {
  const prefix = base.replace(/\/$/, '');
  const visit = ({ tagName, properties, children }: Node): void => {
    const attribute = tagName === undefined ? undefined : ATTRIBUTE[tagName];
    if (attribute !== undefined && properties !== undefined) {
      const value = properties[attribute];
      if (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')) properties[attribute] = `${prefix}${value}`;
    }
    children?.forEach(visit);
  };
  return (tree: Node): void => visit(tree);
}
