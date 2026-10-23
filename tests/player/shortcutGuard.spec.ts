import { describe, expect, it } from 'vitest';

import { shouldIgnoreShortcut } from '@/player/shortcutGuard';

/**
 * REV-18：播放快捷键必须让出弹层与文本输入区
 *
 * 冲突场景：抽屉打开时焦点在面板内按钮上，按空格会同时触发
 * "播放/暂停"和"激活按钮"。这里用真实 DOM 结构断言判定结果。
 */
function makeDialog(children: Element[]): HTMLElement {
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  children.forEach((child) => dialog.append(child));
  return dialog;
}

describe('shouldIgnoreShortcut（REV-18）', () => {
  it('弹层内（role="dialog"）的焦点被忽略', () => {
    const okBtn = document.createElement('button');
    makeDialog([okBtn]);
    expect(shouldIgnoreShortcut(okBtn)).toBe(true);
  });

  it('弹层内的列表项同样被忽略（点击后焦点落在 li 上）', () => {
    const row = document.createElement('li');
    const list = document.createElement('ul');
    list.append(row);
    makeDialog([list]);
    expect(shouldIgnoreShortcut(row)).toBe(true);
  });

  it('input / textarea / select 被忽略', () => {
    expect(shouldIgnoreShortcut(document.createElement('input'))).toBe(true);
    expect(shouldIgnoreShortcut(document.createElement('textarea'))).toBe(true);
    expect(shouldIgnoreShortcut(document.createElement('select'))).toBe(true);
  });

  it('contenteditable 被忽略；contenteditable="false" 不忽略', () => {
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    expect(shouldIgnoreShortcut(editable)).toBe(true);

    const notEditable = document.createElement('div');
    notEditable.setAttribute('contenteditable', 'false');
    expect(shouldIgnoreShortcut(notEditable)).toBe(false);
  });

  it('播放器普通区域不被忽略（快捷键照常生效）', () => {
    const video = document.createElement('video');
    const stage = document.createElement('div');
    stage.className = 'player-stage';
    stage.append(video);
    expect(shouldIgnoreShortcut(video)).toBe(false);
    expect(shouldIgnoreShortcut(stage)).toBe(false);
  });

  it('document.body / 文本节点等非 Element 目标不被忽略', () => {
    expect(shouldIgnoreShortcut(document.body)).toBe(false);
    expect(shouldIgnoreShortcut(null)).toBe(false);
    expect(shouldIgnoreShortcut(document.createTextNode('x'))).toBe(false);
  });

  it('dialog 外的按钮不被忽略', () => {
    const btn = document.createElement('button');
    const wrap = document.createElement('div');
    wrap.append(btn);
    expect(shouldIgnoreShortcut(btn)).toBe(false);
  });

  it('焦点在 body 但页面里有打开的模态弹层 → 忽略（残项：弹层未捕获焦点）', () => {
    const sheet = makeDialog([]);
    document.body.append(sheet);
    try {
      expect(shouldIgnoreShortcut(document.body)).toBe(true);
    } finally {
      sheet.remove();
    }
    expect(shouldIgnoreShortcut(document.body)).toBe(false);
  });
});
