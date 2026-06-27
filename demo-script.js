// The demo the voice guide walks the user through.
//
// Each step has:
//   id        - stable identifier
//   field     - DOM id of the element this step is about (for visual highlight); null = none
//   narration - what the guide SAYS out loud for this step (spoken-style, short sentences)
//   action(s) - what the guide DOES on the form for this step (it fills it in itself,
//               human-like: the cursor glides over, types, opens dropdowns). Use `action`
//               for one or `actions` for several in order:
//                 { type: "type",  field, value }  -> types value into an input
//                 { type: "pick",  field, value }  -> opens a custom dropdown and picks value
//                 { type: "check", field }          -> ticks a checkbox
//                 { type: "click", field }          -> clicks an element (e.g. submit)
//               omit for steps with no on-screen action.
//   context   - extra background the brain (Claude) can use to ANSWER questions about this
//               step. Never spoken; only feeds the Q&A so answers stay on-topic.
//
// Keep narration short: it is read aloud and long monologues hurt voice latency.

export const DEMO = {
  // Product being demoed — gives Claude global context for off-step questions.
  product:
    "This is the Google Account sign-up form. A new user creates a Gmail account by " +
    "entering their first and last name, choosing a username and password, giving their " +
    "date of birth and gender, adding a phone number and a recovery email, picking their " +
    "country, accepting the terms, and clicking Create Account.",

  steps: [
    {
      id: "welcome",
      field: null,
      narration:
        "Hi! Let me show you how to create a Google account. I'll fill it in myself as I go, " +
        "and you can stop me any time to ask a question. Here we go.",
      action: null,
      context:
        "This is the opening. It's the standard Google account sign-up. The guide fills the " +
        "whole form itself, like a person would. The user can interrupt by speaking, or say " +
        "'next' to skip ahead.",
    },
    {
      id: "name",
      field: "firstName",
      narration: "First, your name — first name and last name.",
      actions: [
        { type: "type", field: "firstName", value: "Jane" },
        { type: "type", field: "lastName", value: "Doe" },
      ],
      context:
        "First name and last name are plain text fields. Both are required and shown on the " +
        "account. Any name is accepted.",
    },
    {
      id: "username",
      field: "username",
      narration: "Now we pick a username — this becomes your Gmail address.",
      action: { type: "type", field: "username", value: "jane.doe.demo" },
      context:
        "The username becomes the email address, username@gmail.com. It can use letters, " +
        "numbers and dots, and must be unique. It is required.",
    },
    {
      id: "password",
      field: "password",
      narration: "Then a password, and we type it again to confirm it.",
      actions: [
        { type: "type", field: "password", value: "NovaDemo2026!" },
        { type: "type", field: "confirm", value: "NovaDemo2026!" },
      ],
      context:
        "Two password fields: the password and a confirmation that must match it. A strong " +
        "password mixes letters, numbers and symbols. Both are required.",
    },
    {
      id: "birthday",
      field: "day",
      narration: "Next, the date of birth — the day, the month, and the year.",
      actions: [
        { type: "type", field: "day", value: "14" },
        { type: "pick", field: "dd-month", value: "March" },
        { type: "type", field: "year", value: "1996" },
      ],
      context:
        "Date of birth has three parts: day and year are typed, the month is a dropdown menu. " +
        "Google asks for it to confirm the account meets the minimum age. It is required.",
    },
    {
      id: "gender",
      field: "dd-gender",
      narration: "Then the gender — I'll open the menu and choose.",
      action: { type: "pick", field: "dd-gender", value: "Female" },
      context:
        "Gender is a dropdown: Female, Male, Rather not say, or Custom. It's required by the " +
        "form. 'Rather not say' is there for anyone who prefers not to share it.",
    },
    {
      id: "phone",
      field: "phone",
      narration: "A phone number now — it helps keep the account secure.",
      action: { type: "type", field: "phone", value: "600 123 456" },
      context:
        "The phone number is used for security and account recovery, for example to verify " +
        "it's really you or to reset a forgotten password.",
    },
    {
      id: "recovery",
      field: "recovery",
      narration: "And a recovery email, in case you ever get locked out.",
      action: { type: "type", field: "recovery", value: "jane.recovery@example.com" },
      context:
        "The recovery email is a backup address used to regain access if you forget your " +
        "password or get locked out. It's optional but strongly recommended.",
    },
    {
      id: "country",
      field: "dd-country",
      narration: "We pick the country or region from the menu.",
      action: { type: "pick", field: "dd-country", value: "Spain" },
      context:
        "Country or region is a dropdown. It sets the account's region for things like " +
        "language and local services. It is required.",
    },
    {
      id: "terms",
      field: "terms-field",
      narration: "I'll tick the box to accept the terms of service.",
      action: { type: "check", field: "terms" },
      context:
        "This checkbox accepts the Terms of Service and Privacy Policy. You can't create the " +
        "account without ticking it.",
    },
    {
      id: "submit",
      field: "submit",
      narration: "And finally, we click Create Account to finish.",
      action: { type: "click", field: "submit" },
      context:
        "The Create Account button submits the form. It checks the required fields and that " +
        "the passwords match, then confirms the new account. After this you'd land on your " +
        "new inbox.",
    },
    {
      id: "done",
      field: null,
      narration:
        "And that's it — the account is created! Want me to go over anything again?",
      action: null,
      context:
        "The demo is finished. The account is created. The user can ask follow-up questions " +
        "or restart the demo.",
    },
  ],
};
