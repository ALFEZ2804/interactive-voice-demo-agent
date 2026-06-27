// The demo the voice guide walks the user through.
//
// Each step has:
//   id        - stable identifier
//   field     - DOM id of the element this step is about (for visual highlight); null = none
//   narration - what the guide SAYS out loud for this step (spoken-style, short sentences)
//   action(s) - what the guide DOES on the page for this step (it drives the CRM itself,
//               human-like: the cursor glides over, clicks tabs, types, opens dropdowns).
//               Use `action` for one or `actions` for several in order:
//                 { type: "type",  field, value }  -> types value into an input (field = id)
//                 { type: "pick",  field, value }  -> opens a custom dropdown and picks value
//                                                     (field = id of the .dropdown wrapper)
//                 { type: "check", field }          -> ticks a checkbox (field = id)
//                 { type: "click", field }          -> clicks an element (field = id)
//               omit for steps with no on-screen action.
//   context   - extra background the brain (Claude) can use to ANSWER questions about this
//               step. Never spoken; only feeds the Q&A so answers stay on-topic.
//
// IMPORTANT (single-page app): a step that interacts with a view must FIRST click that
// view's nav tab, because the human motor can't glide to an element that lives in a hidden
// (display:none) view — its bounding box is zero. So view-changing steps lead with a
// { click: nav-* } action before any type/pick/click on that view's elements.
//
// Keep narration short: it is read aloud and long monologues hurt voice latency.

export const DEMO = {
  // Product being demoed — gives Claude global context for off-step questions.
  product:
    "This is a sales CRM — a tool a sales team uses to track the people and companies they " +
    "sell to. It has a Dashboard with key numbers, a Contacts list where every record can be " +
    "edited, an Opportunities pipeline that shows deals by stage, and a Communications screen " +
    "that drafts follow-up emails for you with AI. All the data shown is made-up sample data.",

  steps: [
    {
      id: "welcome",
      field: null,
      narration:
        "Hi! Let me give you a quick tour of this CRM. I'll click through it myself as I go, " +
        "and you can stop me any time to ask a question. Here we go.",
      action: null,
      context:
        "This is the opening of a guided tour of a sales CRM. The guide drives the app itself, " +
        "like a person would. The user can interrupt by speaking, or say 'next' to skip ahead.",
    },
    {
      id: "dashboard",
      field: "kpi-row",
      narration:
        "This is the dashboard — your whole pipeline at a glance: open deals, their total " +
        "value, deals won this month, and your win rate.",
      action: { type: "click", field: "nav-dashboard" },
      context:
        "The dashboard shows top-level numbers: number of open deals, total pipeline value in " +
        "euros, deals won this month, and the win rate. Below it, a small chart breaks deal " +
        "value down by stage. All figures are illustrative sample data, not real.",
    },
    {
      id: "contacts",
      field: "contacts-table",
      narration:
        "Over in Contacts you've got everyone you're working with — name, company, email and " +
        "where they are in your funnel. Let me add a new one.",
      action: { type: "click", field: "nav-contacts" },
      context:
        "The Contacts view is a table of people: name, company, email, and a status (Lead, " +
        "Qualified, Customer or Churned). Each row can be opened and edited. There's a button " +
        "to add a new contact.",
    },
    {
      id: "new-contact",
      field: "contact-modal",
      narration:
        "I'll pop in their name, company and email, mark them as a new lead, and save.",
      actions: [
        { type: "click", field: "btn-new-contact" },
        { type: "type", field: "cm-name", value: "Elena Ortiz" },
        { type: "type", field: "cm-company", value: "Vertex Labs" },
        { type: "type", field: "cm-email", value: "elena@vertexlabs.io" },
        { type: "pick", field: "dd-cm-status", value: "Lead" },
        { type: "click", field: "cm-save" },
      ],
      context:
        "The new-contact form asks for name, company, email and a status chosen from a dropdown " +
        "(Lead, Qualified, Customer, Churned). Saving adds the person to the contacts list. The " +
        "details typed here are made-up sample data.",
    },
    {
      id: "edit-contact",
      field: "contacts-table",
      narration:
        "And every record is editable — let me open an existing contact and move them up to " +
        "qualified.",
      actions: [
        { type: "click", field: "row-edit-1" },
        { type: "pick", field: "dd-cm-status", value: "Qualified" },
        { type: "click", field: "cm-save" },
      ],
      context:
        "Any contact can be edited by clicking the pencil on its row, which opens the same form " +
        "pre-filled. Here we change a contact's status to Qualified. Nothing here is permanent " +
        "real data — it's a demo.",
    },
    {
      id: "pipeline",
      field: "pipeline-board",
      narration:
        "This is the pipeline — your deals laid out by stage, from new leads all the way " +
        "through to closed-won.",
      action: { type: "click", field: "nav-pipeline" },
      context:
        "The Opportunities pipeline shows deals as cards in columns by stage: Lead, Qualified, " +
        "Proposal and Won. Each card shows the company and the deal value. The column headers " +
        "show how many deals are in each stage.",
    },
    {
      id: "advance-deal",
      field: "pipeline-board",
      narration:
        "As a deal moves forward, you push it along — let me move this one into proposal.",
      action: { type: "click", field: "deal-advance-1" },
      context:
        "Each deal card has an arrow to advance it to the next stage. Advancing moves the card " +
        "into the next column and updates the pipeline counts and totals.",
    },
    {
      id: "comms",
      field: "comms-panel",
      narration:
        "And here's the part I like most — communications. It writes your follow-up emails " +
        "for you.",
      action: { type: "click", field: "nav-comms" },
      context:
        "The Communications view drafts a follow-up email for a chosen contact using AI. You " +
        "pick the contact and the kind of email, generate a draft, then edit it freely with a " +
        "live preview of how it'll look before sending.",
    },
    {
      id: "draft-email",
      field: "comms-panel",
      narration:
        "Watch — I'll pick the contact I just added and have it write a follow-up. It's " +
        "drafting it now.",
      actions: [
        { type: "pick", field: "dd-comms-contact", value: "Elena Ortiz" },
        { type: "click", field: "btn-draft" },
      ],
      context:
        "The Draft button generates a real email with a subject and body, written for the " +
        "selected contact by AI, in a second or two. The text is fully editable and the panel " +
        "on the right previews it live, exactly as it would be sent.",
    },
    {
      id: "done",
      field: null,
      narration:
        "And that's the tour — everything you saw is editable, and that email was written on " +
        "the spot. Want me to go over anything again?",
      action: null,
      context:
        "The tour is finished. The highlights were: editable contact records, a stage-based " +
        "deal pipeline, and AI-drafted follow-up emails. The user can ask follow-up questions " +
        "or restart the demo.",
    },
  ],
};
