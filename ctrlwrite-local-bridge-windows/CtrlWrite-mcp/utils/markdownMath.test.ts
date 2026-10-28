import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownContent } from '../components/MarkdownContent';

const render = (content: string) => renderToStaticMarkup(React.createElement(MarkdownContent, { children: content }));

test('the reported same-line equation renders as display math with its number', () => {
    const content = String.raw`$$r_{c,k}=G_{k,k}b_{c,k}+\sum_{l\ne k}G_{k,l}b_{c,l}\tag{7}$$`;
    const html = render(content);
    assert.match(html, /class="katex-display"/);
    assert.match(html, /class="tag"/);
    assert.doesNotMatch(html, /katex-error/);
    assert.match(html, new RegExp(`data-markdown-start="0" data-markdown-end="${content.length}"`));
});

test('inline formulas and multiline numbered formulas use the right layout', () => {
    const inline = render(String.raw`相位为 $\Delta\varphi_k$，距离为 $L$。`);
    assert.equal((inline.match(/class="katex"/g) || []).length, 2);
    assert.doesNotMatch(inline, /katex-display|katex-error/);
    const block = render('$$\r\n' + String.raw`\hat b_c=(H^{\mathrm H}H)^{-1}H^{\mathrm H}z_c\tag{8}` + '\r\n$$');
    assert.match(block, /katex-display/);
    assert.match(block, /class="tag"/);
    assert.doesNotMatch(block, /katex-error/);
});

test('common operators, sums and wrapped phase formulas render without errors', () => {
    const formulas = [
        String.raw`\Delta\varphi_k=\operatorname{wrap}[\beta_k-4\pi n_g f_k L/c_0]\tag{1}`,
        String.raw`L=c_0(2\pi q_k+\theta_k)/(4\pi n_g f_k)\tag{2}`,
        String.raw`\sigma_{L,k}=c_0\sigma_{\theta,k}/(4\pi n_g f_k)\tag{3}`,
        String.raw`D_{\mathrm{syn}}=c_0/[2n_g|f_2-f_1|]\tag{4}`,
        String.raw`x_c[n]=\sum_k A_{c,k}\cos\{2\pi f_k(t_n+\varepsilon_c[n])+\varphi_{c,k}\}+w_c[n]\tag{5}`,
        String.raw`\delta\varphi_k[n]=2\pi f_k(\delta t_{\mathrm{mea}}[n]-\delta t_{\mathrm{ref}}[n])\tag{6}`,
        String.raw`\Delta\hat\varphi_k=\arg[Z_{\mathrm{mea},k}\cdot\operatorname{conj}(Z_{\mathrm{ref},k})]\tag{9}`
    ];
    for (const formula of formulas) {
        const html = render(`$$${formula}$$`);
        assert.match(html, /katex-display/);
        assert.doesNotMatch(html, /katex-error/, formula);
    }
});

test('math source offsets survive rendering without annotating generated math glyphs', () => {
    const content = '前文\r\n\r\n公式 $x^2$ 后文';
    const html = render(content);
    const start = content.indexOf('$');
    assert.match(html, new RegExp(`data-markdown-math="true" data-markdown-start="${start}" data-markdown-end="${start + 5}"`));
    assert.equal((html.match(/data-markdown-text=/g) || []).length, 3);
    assert.doesNotMatch(html, /class="katex[^>]*data-markdown-text/);
});

test('bad formulas fall back to their source and leave surrounding text visible', () => {
    const html = render(String.raw`Before $\frac{1$ after.`);
    assert.match(html, /katex-error/);
    assert.match(html, /Before/);
    assert.match(html, /after\./);
    assert.match(html, /\\frac\{1/);
});

test('tables and code examples keep their Markdown behavior', () => {
    const html = render('| Name | Value |\n| --- | --- |\n| phase | $x^2$ |\n\n`$literal$`\n\n```latex\n$$not math$$\n```');
    assert.match(html, /<table>/);
    assert.equal((html.match(/class="katex"/g) || []).length, 1);
    assert.match(html, /\$literal\$/);
    assert.match(html, /\$\$not math\$\$/);
});

test('math code fences render and untrusted formula links do not become active links', () => {
    const html = render('```math\nx^2\n```');
    assert.match(html, /katex-display/);
    assert.doesNotMatch(html, /<pre>/);
    const unsafe = render(String.raw`$\href{javascript:alert(1)}{click}$`);
    assert.doesNotMatch(unsafe, /href="javascript:/);
});
