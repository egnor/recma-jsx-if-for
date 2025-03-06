# recma-plugin-jsx-if-for
MDX plugin (https://github.com/mdx-js/recma) to translate
&lt;$if>, &lt;$for>, &lt;$let>, etc. into Javascript

This is a [recma plugin](https://github.com/mdx-js/recma)
(for [MDX](https://mdxjs.com/), etc.) which rewrites
[JSX content](https://react.dev/learn/writing-markup-with-jsx)
(whether or not React is used) so certain "pseudo-component" tags are
converted to corresponding Javascript expressions:

- `<$if test={expr}>...</$if>` becomes `{(expr) ? <>...</> : null}`
- `<$for var="id" of={expr}>...</$for>` becomes `{(expr).map((id) => <> ... </>)}`
- `<$let var="id" value={expr}>...</$let>` becomes `{((id) => <> ... </>)(expr)}`

Note that `var` in `<$for>` and `<$let>` may be a variable name or a
destructuring pattern, and `of` and `value` may be any Javascript expression:
```jsx
<$for var="{x, y}" of {[{x: 1, y: 2}, {x: 3, y: 4}]}>
  <div>x is {x}, y is {y}</div>
</$for>
```

## Why?

In most contexts you can and should write the `{...}` equivalent directly.

However, [MDX](https://mdxjs.com/) (Markdown with JSX support)
only allows Markdown content inside component tags, not inside Javascript
curly braces. (See
[these](https://github.com/orgs/mdx-js/discussions/2581)
[discussions](https://github.com/orgs/mdx-js/discussions/2276).)

While this plugin isn't technically MDX-specific, it exists mostly to
deal with this MDX quirk and let you write conditions, loops, and local
variable bindings around Markdown content. ("Traditional" template
languages often use tag-based conditionals and loops in this way.)

## Usage

Add this module:
```sh
npm i recma-plugin-jsx-if-for
```

Configure MDX to use this plugin,
[wherever you integrate MDX](https://mdxjs.com/docs/getting-started/):
```js
import recmaJsxIfFor from "recma-plugin-jsx-if-for";
...
const mdxOptions = { jsx: true, recmaPlugins: [recmaJsxIfFor] };
...
```

> [!NOTE]
> At present, this plugin requires `jsx: true` in MDX options,
> as it processes uncompiled JSX. You will need your bundler to process MDX.

## Tips and Pitfalls

### ⚠️ Don't use MDX `export` inside tag scopes (use `<$let>` instead)

In MDX content, `<$if>`, `<$for>`, and `<$let>` tags will wrap Markdown/JSX,
BUT ALL `export` directives are executed globally first. This will NOT work:

```mdx
<$for var="i" of={[1, 2, 3]}>
  export const j = i * 2;  // WILL FAIL, is evaluated ONCE, OUTSIDE the loop
  ## {i} times 2 is {j}   {/* WILL NOT WORK */}
</$for>
```

Instead, use `<$let>` for local bindings, like this:
```mdx
<$for var="i" of={[1, 2, 3]}>
  <$let var="j" value={i * 2}>
    ## {i} times 2 is {j}
  </$let>
</$for>
```

### ℹ️ Ways to avoid nested `<$let>` towers

If you find yourself with towers of annoyingly nested dependent `<$let>` tags:
```mdx
<$let var="x" value={3.14159}>
  <$let var="y" value={x * x}>
    <$let var="z" value={y / (x + 1)}>
      ## x={x} y={y} z={z}
    </$let>
  </$let>
</$let>
```

Consider instead building an object in an immediately invoked function:
```mdx
<$let var="{x, y, z}" value={(() =>
  const x = 3.14159;
  const y = x * x;
  const z = y / (x + 1);
  return {x, y, z};
)()}>
  ## x={x} y={y} z={z}
</$let>
```

You could also use a named function with MDX `export` (if the function can run
in global scope):

```mdx
export function getXYZ() {
  const x = 3.14159;
  const y = x * x;
  const z = y / (x + 1);
  return {x, y, z};
}

...
<$let var="{x, y, z}" value={getXYZ()}>
  ## x={x} y={y} z={z}
</$let>
```

You could even `import` the function from another module entirely, if that
makes sense for you.
