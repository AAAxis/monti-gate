// "About Telegram notifications" -- what the Notification bot view does, and
// what pressing Link actually links.
//
// Copy only, like PROFILE_INTRO_STEPS and COOKIE_INTRO_STEPS: it will be
// rewritten more often than IntroModal, and keeping it out keeps that dialog
// navigation. The figures are named but not yet shot -- the modal draws its
// labelled placeholder at the right aspect ratio until the pictures land in
// assets/intro, and dropping them in later moves no layout (add an
// `image: <import>` per step then).
import type {IntroStep} from './profileIntro';

export const TELEGRAM_INTRO_STEPS: IntroStep[] = [
  {
    title: 'Scout Web can message you on Telegram',
    body: 'When an automation finishes — at three in the morning, on a schedule, or ' +
      'started by an agent — the workspace\'s bot sends the verdict to your own ' +
      'Telegram chat: what ran, on which profile, and whether it succeeded. One bot ' +
      'serves the whole team, but every message is personal: you only hear about the ' +
      'automations you subscribed to.',
    // Captions describe what is actually in the frame, not what the step is
    // about -- the same rule the other intros follow.
    caption: 'A run\'s verdict, delivered to a Telegram chat.',
    figure: 'telegram-message',
  },
  {
    title: 'Link once, then subscribe per automation',
    body: 'Link Telegram opens the bot in your own browser; pressing Start there ' +
      'connects your chat, and nobody else can see or use it. After that, open any ' +
      'automation and set Personal Telegram to every run or failures only. Teammates ' +
      'link their own chats and pick their own automations — your subscriptions never ' +
      'ring anyone else\'s phone.',
    caption: 'The Personal Telegram setting inside an automation\'s editor.',
    figure: 'telegram-subscribe',
  },
];
