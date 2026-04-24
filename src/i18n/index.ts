import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import {
    SUPPORTED_LANGUAGE_CODES,
    resolveSupportedLanguage,
    type LanguageCode,
} from '../../shared/language';

// EN
import enCommon from './locales/en/common.json';
import enSettings from './locales/en/settings.json';
import enDashboard from './locales/en/dashboard.json';
import enChat from './locales/en/chat.json';
import enChannels from './locales/en/channels.json';
import enAgents from './locales/en/agents.json';
import enSkills from './locales/en/skills.json';
import enCron from './locales/en/cron.json';
import enSetup from './locales/en/setup.json';

// ZH
import zhCommon from './locales/zh/common.json';
import zhSettings from './locales/zh/settings.json';
import zhDashboard from './locales/zh/dashboard.json';
import zhChat from './locales/zh/chat.json';
import zhChannels from './locales/zh/channels.json';
import zhAgents from './locales/zh/agents.json';
import zhSkills from './locales/zh/skills.json';
import zhCron from './locales/zh/cron.json';
import zhSetup from './locales/zh/setup.json';

// KM (Cambodian) - using EN as placeholder
import kmCommon from './locales/km/common.json';
import kmSettings from './locales/km/settings.json';
import kmDashboard from './locales/km/dashboard.json';
import kmChat from './locales/km/chat.json';
import kmChannels from './locales/km/channels.json';
import kmAgents from './locales/km/agents.json';
import kmSkills from './locales/km/skills.json';
import kmCron from './locales/km/cron.json';
import kmSetup from './locales/km/setup.json';

// ID (Indonesian) - using EN as placeholder
import idCommon from './locales/id/common.json';
import idSettings from './locales/id/settings.json';
import idDashboard from './locales/id/dashboard.json';
import idChat from './locales/id/chat.json';
import idChannels from './locales/id/channels.json';
import idAgents from './locales/id/agents.json';
import idSkills from './locales/id/skills.json';
import idCron from './locales/id/cron.json';
import idSetup from './locales/id/setup.json';

export const SUPPORTED_LANGUAGES = [
    { code: 'en', label: 'English' },
    { code: 'zh', label: '中文' },
    { code: 'km', label: 'Khmer' },
    { code: 'id', label: 'Bahasa Indonesia' },
] as const satisfies ReadonlyArray<{ code: LanguageCode; label: string }>;

const resources = {
    en: {
        common: enCommon,
        settings: enSettings,
        dashboard: enDashboard,
        chat: enChat,
        channels: enChannels,
        agents: enAgents,
        skills: enSkills,
        cron: enCron,
        setup: enSetup,
    },
    zh: {
        common: zhCommon,
        settings: zhSettings,
        dashboard: zhDashboard,
        chat: zhChat,
        channels: zhChannels,
        agents: zhAgents,
        skills: zhSkills,
        cron: zhCron,
        setup: zhSetup,
    },
    km: {
        common: kmCommon,
        settings: kmSettings,
        dashboard: kmDashboard,
        chat: kmChat,
        channels: kmChannels,
        agents: kmAgents,
        skills: kmSkills,
        cron: kmCron,
        setup: kmSetup,
    },
    id: {
        common: idCommon,
        settings: idSettings,
        dashboard: idDashboard,
        chat: idChat,
        channels: idChannels,
        agents: idAgents,
        skills: idSkills,
        cron: idCron,
        setup: idSetup,
    },
};

i18n
    .use(initReactI18next)
    .init({
        resources,
        lng: resolveSupportedLanguage(typeof navigator !== 'undefined' ? navigator.language : undefined),
        fallbackLng: 'en',
        supportedLngs: [...SUPPORTED_LANGUAGE_CODES],
        defaultNS: 'common',
        ns: ['common', 'settings', 'dashboard', 'chat', 'channels', 'agents', 'skills', 'cron', 'setup'],
        interpolation: {
            escapeValue: false,
        },
        react: {
            useSuspense: false,
        },
    });

export default i18n;
