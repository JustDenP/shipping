import { LanguageCode, ShippingEligibilityChecker } from '@vendure/core';

export const easyPostEligibilityChecker = new ShippingEligibilityChecker({
    code: 'easy-post-eligibility-checker',
    description: [
        {
            languageCode: LanguageCode.en,
            value: 'EasyPost Eligibility Checker -- all shipments are eligible',
        },
    ],
    args: {},
    check: () => true,
});
