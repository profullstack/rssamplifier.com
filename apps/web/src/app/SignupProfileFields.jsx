'use client';

import { ProfileFields } from '@profullstack/profile/react';

/**
 * The signup profile fields from @profullstack/profile, minus the email box the
 * sign-in form already has. A client module of its own because the package's
 * React entry is one, and a server component should only ever render it.
 *
 * @param {{ errors?: Record<string, string>, defaultValues?: Record<string, string> }} props
 */
export default function SignupProfileFields({ errors, defaultValues }) {
  return (
    <ProfileFields
      fields={['first_name', 'last_name', 'company_domain', 'job_title', 'linkedin_url']}
      errors={errors}
      defaultValues={defaultValues}
      idPrefix="signup-"
    />
  );
}
