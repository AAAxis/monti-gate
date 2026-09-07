// The three screens shown to someone who has never made a profile.
//
// Content lives here rather than in the modal for the same reason
// Integration.steps does: it is copy, it will be rewritten more often than the
// component, and keeping it out means the modal is only navigation.
//
// `figure` names the screenshot each step carries, and matches the file's name
// in assets/intro. A step may still be written before its picture exists -- the
// modal draws a labelled placeholder at the right aspect ratio in the meantime,
// so dropping one in later moves no layout.
// Shared with data/cookieIntro.ts -- IntroModal renders both from this shape.
import identityShot from '../assets/intro/profile-identity.png';
import organisedShot from '../assets/intro/profiles-organised.png';
import listShot from '../assets/intro/profiles-list.png';

export type IntroStep = {
  title: string;
  body: string;
  // Short line under the figure. Says what the picture shows, so the step still
  // makes sense while the picture is a placeholder.
  caption: string;
  figure: string;
  // The screenshot itself, once one exists. Omitted while `figure` is still only
  // a name: the modal then draws its labelled placeholder at the same aspect
  // ratio, so the two kinds of step sit at the same height in the same dialog.
  image?: string;
  // Fill the frame edge to edge rather than sitting letterboxed inside it.
  //
  // Only for shots of the whole app window, where the outer band is desktop
  // wallpaper and losing some of it costs nothing. A cropped UI detail must NOT
  // set this: filling makes the frame crop to 16:10, and on a shot that is
  // already tight to its subject that takes the subject with it. Default off
  // for exactly that reason -- see .intro-figure-frame in styles.css.
  fill?: boolean;
};

export const PROFILE_INTRO_STEPS: IntroStep[] = [
  {
    title: 'A profile is a whole separate browser',
    body: 'Each one keeps its own cookies, storage, history and logins in its own folder ' +
      'on disk. Two profiles never see each other, so you can stay signed in to a dozen ' +
      'accounts on the same site at once without any of them noticing the others.',
    // Captions describe what is actually in the frame, not what the step is
    // about -- the same rule COOKIE_INTRO_STEPS follows.
    caption: 'Every profile in the workspace, side by side.',
    figure: 'profiles-list',
    image: listShot,
    fill: true,
  },
  {
    title: 'Give it an identity',
    // Kept to roughly the length of the other two steps' bodies, so the
    // paragraph under the figure is the same depth on all three and Next does
    // not shift the footer. Around 235 characters is the budget.
    body: 'The platform and fingerprint decide what a site sees; the proxy decides where ' +
      'it appears to be. Scout Web keeps those consistent for you: pick a platform and the ' +
      'hardware re-rolls to match it, and the timezone and language follow the proxy.',
    caption: 'A new profile: its proxy and fingerprint.',
    figure: 'profile-identity',
    image: identityShot,
    fill: true,
  },
  {
    title: 'Launch, then keep it organised',
    body: 'Launch opens Scout Web Browser on that identity. As the list grows, folders group ' +
      'profiles, statuses track where each one stands, and colours and tags make a row ' +
      'findable at a glance. Deleted profiles wait in Trash for 30 days before they go.',
    caption: 'A folder being named, given an icon and a colour.',
    figure: 'profiles-organised',
    image: organisedShot,
    fill: true,
  },
];
