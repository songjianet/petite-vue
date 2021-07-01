import { builtInDirectives, Directive } from './directives'
import { _if } from './directives/if'
import { _for } from './directives/for'
import { bind } from './directives/bind'
import { createDataContext } from './directives/data'
import { on } from './directives/on'
import { text } from './directives/text'
import { evaluate } from './eval'
import { effect as rawEffect, reactive, ReactiveEffect } from '@vue/reactivity'
import { Block } from './block'
import { queueJob } from './scheduler'

export interface Context {
  scope: Record<string, any>
  dirs: Record<string, Directive>
  blocks: Block[]
  effect: typeof rawEffect
  effects: ReactiveEffect[]
  cleanups: (() => void)[]
}

export function createContext(parent?: Context): Context {
  const ctx: Context = {
    ...parent,
    scope: parent ? parent.scope : reactive({}),
    dirs: parent ? parent.dirs : {},
    effects: [],
    blocks: [],
    cleanups: [],
    effect: (fn) => {
      const e: ReactiveEffect = rawEffect(fn, {
        scheduler: () => queueJob(e)
      })
      ctx.effects.push(e)
      return e
    }
  }
  return ctx
}

const dirRE = /^(?:v-|:|@)/
const modifierRE = /\.([\w-]+)/g
const interpolationRE = /\{\{([^]+?)\}\}/g

export function walk(node: Node, ctx: Context): ChildNode | null | void {
  const type = node.nodeType
  if (type === 1) {
    // Element
    const el = node as Element
    if (el.hasAttribute('v-pre')) {
      return
    }

    let exp: string | null

    // v-if
    if ((exp = el.getAttribute('v-if'))) {
      return _if(el, exp, ctx)
    }

    // v-for
    if ((exp = el.getAttribute('v-for'))) {
      return _for(el, exp, ctx)
    }

    // v-data
    if ((exp = el.getAttribute('v-data'))) {
      ctx = createDataContext(ctx, evaluate(ctx.scope, exp))
      el.removeAttribute('v-data')
    }

    // other directives
    for (const { name, value } of [...el.attributes]) {
      if (dirRE.test(name) && name !== 'v-cloak') {
        processDirective(el, name, value, ctx)
      }
    }
  } else if (type === 3) {
    // Text
    const data = (node as Text).data
    if (data.includes('{{')) {
      let segments: string[] = []
      let lastIndex = 0
      let match
      while ((match = interpolationRE.exec(data))) {
        const leading = data.slice(lastIndex, match.index)
        if (leading) segments.push(JSON.stringify(leading))
        segments.push(`$.toDisplayString(${match[1]})`)
        lastIndex = match.index + match[0].length
      }
      if (lastIndex < data.length - 1) {
        segments.push(JSON.stringify(data.slice(lastIndex)))
      }
      applyDirective(node, text, segments.join('+'), ctx)
    }
  }

  if (type === 1 || type === 11) {
    // element or fragment - process children
    let child = node.firstChild
    while (child) {
      child = walk(child, ctx) || child.nextSibling
    }
  }
}

function processDirective(el: Element, raw: string, exp: string, ctx: Context) {
  let dir: Directive
  let arg: string | undefined
  let modifiers: Record<string, true> | undefined

  // modifiers
  let modMatch: RegExpExecArray | null = null
  while ((modMatch = modifierRE.exec(raw))) {
    ;(modifiers || (modifiers = {}))[modMatch[1]] = true
    raw = raw.slice(0, modMatch.index)
  }

  if (raw[0] === ':') {
    dir = bind
    arg = raw.slice(1)
  } else if (raw[0] === '@') {
    dir = on
    arg = raw.slice(1)
  } else {
    const argIndex = raw.indexOf(':')
    const dirName = argIndex > 0 ? raw.slice(2, argIndex) : raw.slice(2)
    dir = builtInDirectives[dirName] || ctx.dirs[dirName]
    arg = argIndex > 0 ? raw.slice(argIndex + 1) : undefined
  }
  if (dir) {
    applyDirective(el, dir, exp, ctx, arg, modifiers)
    el.removeAttribute(raw)
  } else if (import.meta.env.DEV) {
    console.error(`unknown custom directive ${raw}.`)
  }
}

function applyDirective(
  el: Node,
  dir: Directive<any>,
  exp: string,
  ctx: Context,
  arg?: string,
  modifiers?: Record<string, true>
) {
  const get = (e = exp) => evaluate(ctx.scope, e, el)
  const cleanup = dir({ el, get, effect: ctx.effect, ctx, exp, arg, modifiers })
  if (cleanup) {
    ctx.cleanups.push(cleanup)
  }
}
