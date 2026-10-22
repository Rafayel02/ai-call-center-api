import { DemoLanguage } from './dto/save-demo-profile.dto';

export interface ProfileCopy {
  heading: string;
  introduction: string;
  starters: string[];
}

export const TEAM_PROFILE = {
  key: 'team',
  displayName: 'Team Telecom Armenia',
  defaultLanguage: 'hy' as DemoLanguage,
  accent: '#e1064a',
  copy: {
    hy: {
      heading: 'Արհեստական բանականությամբ սպասարկման ցուցադրություն՝ պատրաստված Team Telecom Armenia-ի համար։',
      introduction:
        'Տեսեք, թե ինչպես հայերեն խոսող օգնականը կարող է օգնել առօրյա հարցերով, ուղղորդել My Team հավելվածում և հասկանալ, երբ հարկավոր է մարդկային աջակցություն։',
      starters: [
        'Ի՞նչ կարող եմ անել My Team հավելվածում։',
        'Ինչպե՞ս ստուգեմ մնացորդս և փաթեթի մնացած ծավալը։',
        'Կարո՞ղ եմ փաթեթս փոխել My Team-ով։',
        'Օպերատորի օգնություն է պետք։',
      ],
    },
    en: {
      heading: 'An AI customer-service demo prepared for Team Telecom Armenia.',
      introduction:
        'Explore how an Armenian-speaking AI assistant could help customers with routine inquiries, guide them through My Team, and identify when human support is needed.',
      starters: [
        'What can I do in the My Team app?',
        'How can I check my balance and remaining allowance?',
        'Can I change my package through My Team?',
        'I need help from an operator.',
      ],
    },
    ru: {
      heading: 'Демонстрация ИИ-обслуживания, подготовленная для Team Telecom Armenia.',
      introduction:
        'Посмотрите, как армяноязычный помощник может отвечать на обычные вопросы, подсказывать по приложению My Team и понимать, когда нужна помощь человека.',
      starters: [
        'Что я могу сделать в приложении My Team?',
        'Как проверить баланс и остаток пакета?',
        'Можно ли сменить пакет через My Team?',
        'Мне нужна помощь оператора.',
      ],
    },
  } satisfies Record<DemoLanguage, ProfileCopy>,
};
