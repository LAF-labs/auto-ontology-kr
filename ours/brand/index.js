/**
 * Product name and logo. Provides `productBrand` ({ name, logoSvg, logoUri })
 * for other host packages, rewrites the served index.html title and icons, and
 * hands the same values to the browser half as the page global `__OURS_BRAND__`.
 */
import { readFileSync } from 'node:fs'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_LOGO_SVG, DEFAULT_NAME, assertSvg, brandIndexHtml, svgDataUri } from './src/brand.js'

export default class ProductBrand extends Service {
  static Config = z.object({
    name: z.string().default(DEFAULT_NAME).description('Product name: window title, sidebar head, sign-in page.'),
    logoFile: z.string().description('Absolute path of an SVG file used as the mark and the favicon. Unset uses a neutral mark.'),
  })

  constructor(ctx, config) {
    super(ctx, 'productBrand')
    this.name = config.name.trim() || DEFAULT_NAME
    this.logoSvg = config.logoFile === undefined
      ? DEFAULT_LOGO_SVG
      : assertSvg(readFileSync(config.logoFile, 'utf8'), config.logoFile)
    this.logoUri = svgDataUri(this.logoSvg)
    ctx.inject(['webServer'], (web) => {
      web.on('webserver/index-inject', (table) => {
        table.push({ kind: 'global', name: '__OURS_BRAND__', value: { name: this.name, logoUri: this.logoUri } })
      })
      web.effect(() => web.webServer.tapIndex(html => brandIndexHtml(html, this)), 'brand: index title and icons')
    })
  }
}
