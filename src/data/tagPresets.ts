// The tags the app suggests, and how each one is drawn.
//
// Same trick as FOLDER_ICONS: what lands in profiles.tags is the slug, a dozen
// bytes, never markup or a URL. A tag that is not in this list is a user tag and
// renders neutral, so dropping an entry downgrades old profiles instead of
// breaking them -- and the column stays a plain text[] with no migration.
//
// The marks come in through import.meta.glob rather than one import per file on
// purpose: a missing brand SVG then costs a fallback glyph instead of a build
// error, so this list can name twenty brands before twenty files exist, and
// adding one later is a drop into assets/brands with no code change here.
//
// They are the full-colour brand cuts, so they render through <img> and keep
// their own palette -- the same route data/integrations.ts and PlatformMarks
// take for Windows and Ubuntu. A CSS mask would have been tidier (one ink, no
// theme rules) but it flattens a logo to a silhouette, which turns Instagram's
// gradient and Google's four colours into the same grey blob.
import {
  AtSign, CreditCard, Facebook, Gamepad2, Ghost, Globe, Instagram, Linkedin, MessageCircle,
  Mail, Music2, Package, Palette, Pin, Send, ShoppingCart, Store, Twitch, Twitter, Users,
  Youtube,
} from 'lucide-react';
import type {LucideIcon} from 'lucide-react';
import type {ProfileColorKey} from '../lib/profileColors';

// Vite resolves this at build time to {'../assets/brands/x.svg': '/assets/x-hash.svg'}.
// An empty -- or absent -- folder yields {}, which is the whole point.
const BRAND_FILES = import.meta.glob('../assets/brands/*.svg', {
  eager: true,
  import: 'default',
  query: '?url',
}) as Record<string, string>;

const BRAND_LOGOS: Record<string, string> = Object.fromEntries(
    Object.entries(BRAND_FILES).map(([path, url]) => [
      path.slice(path.lastIndexOf('/') + 1, -'.svg'.length),
      url,
    ]));

// One of the six --profile-* token triples, or 'ink' for the app's own
// accent pair -- near-black on paper, near-white on charcoal, the highest
// contrast either theme has. Reserved for a brand whose mark *is* the absence
// of colour; a second one would just make two tags shout at each other.
// Nothing here names a colour.
export type TagTone = ProfileColorKey | 'ink';

export type TagPreset = {
  // What is stored in profiles.tags when the tag is picked from the catalog.
  slug: string;
  label: string;
  // Shown until assets/brands/<slug>.svg exists. Six of these are lucide's own
  // Feather-era brand glyphs; the rest are the nearest honest stand-in.
  fallback: LucideIcon;
  tone: TagTone;
  // The FOLDER_ICONS key a folder made from this tag starts with.
  folderIcon: string;
  // Other spellings that mean the same brand. Matched after tagKey(), so casing
  // and punctuation are already gone by the time these are consulted.
  aliases?: string[];
  // How a mark that was drawn for one background survives the other. Most need
  // nothing -- a mid-tone brand colour reads on both themes. The three cases
  // that do:
  //
  //   invert-on-light  a mark shipped white (X, Threads). Untouched it is an
  //                    invisible smudge on paper; inverted it is the black cut
  //                    those brands publish for light backgrounds anyway.
  //   invert-on-dark   the same in reverse, for a mark shipped black.
  //   relight-on-dark  for a mark that is dark ink *plus* a brand colour
  //                    (Amazon's wordmark). A plain invert would lift the ink
  //                    but send cyan to red; the extra hue-rotate(180deg) puts
  //                    the hues back where they were, so only the lightness
  //                    flips.
  //   relight-on-light the same, for a mark sitting on an 'ink' chip -- which
  //                    is dark in the *light* theme, so that is the theme its
  //                    mark has to be lifted in.
  adapt?: 'invert-on-light' | 'invert-on-dark' | 'relight-on-dark' | 'relight-on-light';
};

// The brand mark's URL, once assets/brands/<slug>.svg exists. Undefined until
// then, which is what makes `fallback` more than decoration.
export type TagPresetWithLogo = TagPreset & {logo?: string};

// Five is the cap because a profile row has one Tags cell to fit them in, and a
// sixth tag is almost always a folder trying to happen -- which is what the
// folder suggestions in FolderModal exist to catch.
export const MAX_PROFILE_TAGS = 5;

const CATALOG: TagPreset[] = [
  {slug: 'instagram', label: 'Instagram', fallback: Instagram, tone: 'violet', folderIcon: 'megaphone', aliases: ['ig', 'insta']},
  // The one 'ink' tag: TikTok's mark is black, and every pale fill in the six
  // left it either washed out or fighting a hue the brand does not have. The
  // accent pair gives it the darkest chip the light theme can draw -- and
  // because that pair inverts, the mark has to be lifted in *light* rather
  // than dark, which is what relight-on-light says.
  {slug: 'tiktok', label: 'TikTok', fallback: Music2, tone: 'ink', folderIcon: 'megaphone', aliases: ['tt'], adapt: 'relight-on-light'},
  {slug: 'facebook', label: 'Facebook', fallback: Facebook, tone: 'blue', folderIcon: 'megaphone', aliases: ['fb', 'meta']},
  // Blue rather than red: red is YouTube's and Pinterest's, and the four-colour
  // G sitting on a red fill read as a washed-out YouTube at chip size. Blue is
  // the G's leading colour and Google's own UI accent.
  {slug: 'google', label: 'Google', fallback: Globe, tone: 'blue', folderIcon: 'globe', aliases: ['gmail', 'googleads']},
  {slug: 'youtube', label: 'YouTube', fallback: Youtube, tone: 'red', folderIcon: 'megaphone', aliases: ['yt']},
  {slug: 'x', label: 'X', fallback: Twitter, tone: 'slate', folderIcon: 'megaphone', aliases: ['twitter'], adapt: 'invert-on-light'},
  {slug: 'linkedin', label: 'LinkedIn', fallback: Linkedin, tone: 'blue', folderIcon: 'briefcase', aliases: ['li']},
  {slug: 'reddit', label: 'Reddit', fallback: MessageCircle, tone: 'amber', folderIcon: 'users'},
  {slug: 'telegram', label: 'Telegram', fallback: Send, tone: 'blue', folderIcon: 'users', aliases: ['tg']},
  {slug: 'whatsapp', label: 'WhatsApp', fallback: MessageCircle, tone: 'green', folderIcon: 'users', aliases: ['wa']},
  {slug: 'vk', label: 'VK', fallback: Users, tone: 'blue', folderIcon: 'users', aliases: ['vkontakte', 'вк']},
  {slug: 'discord', label: 'Discord', fallback: Gamepad2, tone: 'violet', folderIcon: 'users'},
  {slug: 'pinterest', label: 'Pinterest', fallback: Pin, tone: 'red', folderIcon: 'megaphone'},
  {slug: 'snapchat', label: 'Snapchat', fallback: Ghost, tone: 'amber', folderIcon: 'megaphone', aliases: ['snap'], adapt: 'invert-on-dark'},
  {slug: 'twitch', label: 'Twitch', fallback: Twitch, tone: 'violet', folderIcon: 'megaphone'},
  {slug: 'threads', label: 'Threads', fallback: AtSign, tone: 'slate', folderIcon: 'megaphone', adapt: 'invert-on-light'},
  {slug: 'amazon', label: 'Amazon', fallback: Package, tone: 'amber', folderIcon: 'cart', adapt: 'relight-on-dark'},
  {slug: 'ebay', label: 'eBay', fallback: ShoppingCart, tone: 'blue', folderIcon: 'cart'},
  {slug: 'shopify', label: 'Shopify', fallback: Store, tone: 'green', folderIcon: 'cart'},
  {slug: 'etsy', label: 'Etsy', fallback: Palette, tone: 'amber', folderIcon: 'cart'},
  {slug: 'paypal', label: 'PayPal', fallback: CreditCard, tone: 'blue', folderIcon: 'wallet', aliases: ['pp']},
  {slug: 'outlook', label: 'Outlook', fallback: Mail, tone: 'blue', folderIcon: 'globe', aliases: ['microsoft', 'hotmail', 'live', 'msn']},
];

// The folder colour a suggestion starts with. 'ink' is a chip tone, not one of
// the six a folder can store -- ScoutFolder.color goes through the same
// ColorPicker a profile uses, and a value with no swatch would leave that
// picker showing nothing selected.
export function tagFolderColor(preset: TagPreset): ProfileColorKey {
  return preset.tone === 'ink' ? 'slate' : preset.tone;
}

export const TAG_PRESETS: TagPresetWithLogo[] = CATALOG.map((preset) => ({
  ...preset,
  logo: BRAND_LOGOS[preset.slug],
}));
