// "About cookie-sets" -- what the Cookies tab holds, and how to get one.
//
// Copy only, for the same reason PROFILE_INTRO_STEPS is: it will be rewritten
// far more often than the dialog that shows it, and keeping it out means
// IntroModal stays navigation.
//
// Two screens rather than three because there are only two questions people
// arrive with. What is this, and where do I get one.
import cookieManagerShot from '../assets/intro/cookie-manager.png';
import cookieSetShot from '../assets/intro/cookie-set.png';
import type {IntroStep} from './profileIntro';

export const COOKIE_INTRO_STEPS: IntroStep[] = [
  {
    title: 'A cookie-set is a saved login',
    body: 'When you sign in to a site, it hands the browser a handful of cookies — small ' +
      'named values that say "this browser is that account". Export them and you have a ' +
      'file that can sign a fresh browser back in without ever seeing the password or a ' +
      '2FA code. That file is a cookie-set. Assign one to a profile and it launches ' +
      'already signed in; assign the same set to several profiles and they all open on ' +
      'the same account.',
    // Captions describe what is actually in the frame, not what the step is
    // about -- a caption the picture does not support is worse than none.
    caption: 'A cookie-set opened: every cookie in it, and the profiles using it.',
    figure: 'cookie-set',
    image: cookieSetShot,
    fill: true,
  },
  {
    title: 'Where to get them',
    body: 'Launch any profile and use the built-in Scout Web Cookie Manager to export the ' +
      'session you are signed into — that is the shortest route, and the file lands in ' +
      'the right shape. Anything else that exports cookies works too: Cookie-Editor or ' +
      'EditThisCookie in a normal Chrome, an export from another anti-detect tool, or a ' +
      'cookies.txt from curl. Scout Web reads JSON and Netscape cookies.txt, so drop the ' +
      'file on "+ Cookie-set" and it is in the library. Cookies expire, so a set that ' +
      'worked last month may need re-exporting — open one to see what is in it and when ' +
      'it runs out.',
    caption: 'The Scout Web Cookie Manager, in a launched profile\'s extensions menu.',
    figure: 'cookie-manager',
    image: cookieManagerShot,
    fill: true,
  },
];
