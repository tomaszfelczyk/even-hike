/**
 * Minimal XML reader, just enough for GPX.
 *
 * `DOMParser` exists in the WebView but not in Node, and pulling in a parser
 * for one well-known schema isn't worth a dependency on a device app. This
 * handles what GPX files in the wild actually contain: namespace prefixes,
 * self-closing tags, CDATA in <name>, comments, and character entities.
 */

export interface XmlNode {
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
  text: string
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
}

function decode(source: string): string {
  return source.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return ENTITIES[body] ?? match
  })
}

/** Drop the namespace prefix: `gpxtpx:hr` -> `hr`. */
const local = (name: string) => {
  const colon = name.lastIndexOf(':')
  return colon === -1 ? name : name.slice(colon + 1)
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) attrs[local(m[1])] = decode(m[2] ?? m[3] ?? '')
  return attrs
}

export function parseXml(source: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]
  const top = () => stack[stack.length - 1]
  let i = 0

  while (i < source.length) {
    const lt = source.indexOf('<', i)
    if (lt === -1) break
    if (lt > i) top().text += decode(source.slice(i, lt))

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt)
      i = end === -1 ? source.length : end + 3
      continue
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt)
      top().text += source.slice(lt + 9, end === -1 ? source.length : end)
      i = end === -1 ? source.length : end + 3
      continue
    }
    if (source.startsWith('<?', lt) || source.startsWith('<!', lt)) {
      const end = source.indexOf('>', lt)
      i = end === -1 ? source.length : end + 1
      continue
    }

    // Scan to the closing '>', ignoring any that sit inside an attribute value.
    let j = lt + 1
    let quote = ''
    for (; j < source.length; j++) {
      const c = source[j]
      if (quote) { if (c === quote) quote = '' }
      else if (c === '"' || c === "'") quote = c
      else if (c === '>') break
    }
    const raw = source.slice(lt + 1, j)
    i = j + 1

    if (raw.startsWith('/')) {
      const name = local(raw.slice(1).trim())
      // Tolerate mismatched close tags rather than throwing on a real-world file.
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) { stack.length = k; break }
      }
      continue
    }

    const selfClosing = raw.endsWith('/')
    const body = selfClosing ? raw.slice(0, -1) : raw
    const nameMatch = /^\s*([^\s/>]+)/.exec(body)
    if (!nameMatch) continue
    const node: XmlNode = {
      name: local(nameMatch[1]),
      attrs: parseAttrs(body.slice(nameMatch[0].length)),
      children: [],
      text: '',
    }
    top().children.push(node)
    if (!selfClosing) stack.push(node)
  }

  return root
}

export const child = (node: XmlNode, name: string): XmlNode | undefined =>
  node.children.find(c => c.name === name)

export const childrenNamed = (node: XmlNode, name: string): XmlNode[] =>
  node.children.filter(c => c.name === name)

/** Every descendant with this name, at any depth. */
export function descendants(node: XmlNode, name: string): XmlNode[] {
  const found: XmlNode[] = []
  const walk = (n: XmlNode) => {
    for (const c of n.children) {
      if (c.name === name) found.push(c)
      walk(c)
    }
  }
  walk(node)
  return found
}

export const textOf = (node: XmlNode, name: string): string | undefined =>
  child(node, name)?.text.trim()
