// Ported from accepted backend dfe3a879; see docs/product-tools.md.
import { z } from "zod";
const limits = Object.freeze({ json_bytes: 65536, text_characters: 8e3, title_characters: 128, reason_characters: 2e3, list_items: 100, file_bytes: 2097152, multipart_bytes: 3145728, metadata_bytes: 255 });
const id = z.string().min(1).max(128);
const cid = z.string().regex(/^[a-fA-F0-9]{64}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = (max = 8e3) => z.string().refine((s) => Array.from(s).length <= max, "Text exceeds configured character limit");
const nonempty = (max = 8e3) => text(max).refine((s) => s.trim().length > 0, "Nonempty text required");
const list = (item) => z.array(item).max(100);
const ids = list(id);
const reason = nonempty(2e3);
const object = z.object;
const ref = object({ kind: nonempty(128), id }).strict();
const refs = list(ref);
const audience = z.discriminatedUnion("kind", [
  object({ kind: z.literal("room") }).strict(),
  object({ kind: z.literal("restricted"), participant_ids: ids.min(1) }).strict()
]);
const option = object({ id, label: text(), consequences: text() }).strict();
const disposition = object({ remark_id: id, outcome: z.enum(["integrated", "not_integrated", "superseded", "resolved"]), reason, result_version_id: id.optional(), supersedes_id: id.optional() }).strict().superRefine((v, c) => {
  if (v.outcome === "integrated" && !v.result_version_id) c.addIssue({ code: "custom", path: ["result_version_id"], message: "Integrated disposition requires result version" });
  if (v.outcome === "superseded" && !v.supersedes_id) c.addIssue({ code: "custom", path: ["supersedes_id"], message: "Superseded disposition requires successor" });
});
const issueOutcome = object({ request_id: id, choice_id: id.optional(), custom_outcome: nonempty().optional(), rationale: nonempty() }).strict().refine((v) => Number(v.choice_id !== void 0) + Number(v.custom_outcome !== void 0) === 1, "Exactly one issue outcome required");
const decisionBase = { request_id: id, displayed_subject_hash: hash, rationale: nonempty() };
const empty = object({}).strict();
const decision = z.discriminatedUnion("action", [
  object({ ...decisionBase, action: z.literal("approve_document"), payload: object({ dispositions: list(disposition), issue_outcomes: list(issueOutcome) }).strict() }).strict(),
  object({ ...decisionBase, action: z.literal("reject_document"), payload: object({ dispositions: list(disposition), issue_outcomes: list(issueOutcome) }).strict() }).strict(),
  object({ ...decisionBase, action: z.literal("return_for_revision"), payload: object({ instructions: nonempty() }).strict() }).strict(),
  object({ ...decisionBase, action: z.literal("resolve_issue"), payload: object({ choice_id: id.optional(), custom_outcome: nonempty().optional() }).strict().refine((v) => Number(v.choice_id !== void 0) + Number(v.custom_outcome !== void 0) === 1, "Exactly one issue outcome required") }).strict(),
  ...["confirm_instruction", "reject_instruction", "authorize_disconnect", "decline_disconnect"].map((action) => object({ ...decisionBase, action: z.literal(action), payload: empty }).strict())
]);
const resourceKinds = ["capabilities", "room", "context", "members", "invitation", "inquiry", "version", "review", "remark", "request", "proposal", "result", "history", "source"];
const consumerKinds = ["capabilities", "room", "context", "version", "review", "remark", "request", "proposal", "result", "history", "source"];
const singleton = /* @__PURE__ */ new Set(["capabilities", "room", "context"]);
const readQuery = object({ kind: z.enum(resourceKinds), id: id.optional(), cursor: nonempty().optional(), limit: z.number().int().min(1).max(100).optional(), actor_id: id.optional(), resource_id: id.optional() }).strict().superRefine((v, c) => {
  const invalid = (message) => c.addIssue({ code: "custom", message });
  if (v.kind === "source" && !v.id) invalid("Source identifier required");
  if (singleton.has(v.kind) && (v.id !== void 0 || v.cursor !== void 0 || v.limit !== void 0)) invalid("Singleton does not accept list or detail arguments");
  if (v.id && (v.cursor !== void 0 || v.limit !== void 0)) invalid("Detail does not accept pagination");
  if (v.kind !== "history" && (v.actor_id !== void 0 || v.resource_id !== void 0)) invalid("Filters require history");
});
const followUp = object({ text: nonempty(), responsible_actor_id: id, launch_condition: z.enum(["after_close", "manual_authorization", "after_decision"]), decision_id: id.optional() }).strict().refine((v) => v.launch_condition !== "after_decision" || v.decision_id !== void 0, "Decision required");
const schemas = {
  getSession: empty,
  createSession: object({ provider: nonempty(128), credential: z.unknown().refine((v) => v !== null && v !== void 0, "Credential required") }).strict(),
  deleteSession: empty,
  listRooms: object({ cursor: nonempty().optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  createRoom: object({ title: z.string().transform((v) => v.trim().normalize("NFC")).pipe(nonempty(64)), goal: text(), criteria: list(text()) }).strict(),
  configureRoom: object({ goal: text().optional(), criteria: list(text()).optional(), communication_mode: z.enum(["human_readable", "agent_optimized"]).optional() }).strict().refine((v) => Object.keys(v).length > 0, "At least one field required"),
  closeRoom: object({ reason }).strict(),
  deleteRoom: object({ confirm: z.literal(true), reason }).strict(),
  inviteHuman: object({ role_ids: ids }).strict(),
  inviteAgent: object({ role_ids: ids }).strict(),
  bindAgent: object({ agent_cid: cid, invitation_ref: id }).strict(),
  setRoles: object({ member_id: id, role_ids: ids }).strict(),
  removeMember: object({ member_id: id, reason }).strict(),
  redeemHumanInvitation: object({ token: nonempty() }).strict(),
  commitVersion: object({ document_id: id, source_file_wire_id: nonempty(), parent_version_id: id.optional(), hash }).strict(),
  confirmVersion: object({ version_id: id, hash }).strict(),
  releaseVersion: object({ version_id: id, hash }).strict(),
  openReview: object({ version_id: id, reviewer_ids: ids, publication_rule: nonempty(128) }).strict(),
  closeReview: object({ round_id: id, missing_reviewer_ids: ids, reason }).strict(),
  submitReview: object({ round_id: id, version_id: id, text: text(), evidence: refs }).strict(),
  publishReview: object({ round_id: id }).strict(),
  recordRemark: object({ version_id: id, text: text(), source_message_ref: ref.optional(), supersedes_id: id.optional() }).strict(),
  setRemark: object({ remark_id: id, state: z.enum(["integrated", "not_integrated", "needs_decision", "superseded"]), reason, result_version_id: id.optional(), supersedes_id: id.optional() }).strict().refine((v) => (v.state !== "integrated" || !!v.result_version_id) && (v.state !== "superseded" || !!v.supersedes_id), "Required disposition reference missing"),
  createRequest: object({ kind: z.enum(["issue", "document", "instruction", "disconnect"]), subject: ref, version_id: id.optional(), question: text(), options: list(option), evidence: refs, explanation: text(), issue_ids: ids.optional() }).strict(),
  routeRequest: object({ request_id: id, actor_id: id }).strict(),
  decideRequest: decision,
  cancelRequest: object({ request_id: id, reason }).strict(),
  confirmProposal: object({ proposal_id: id, displayed_hash: hash, action: z.enum(["confirm", "reject"]) }).strict(),
  proposeInstruction: object({ source_message_ref: ref, text: text() }).strict(),
  proposePublication: object({ source_refs: refs, excerpt: text(), target_audience: audience }).strict(),
  postMessage: object({ text: text(), refs, audience }).strict(),
  replyMessage: object({ text: text(), refs, reply_to: ref, audience }).strict(),
  askActor: object({ actor_id: id, question: text(), audience }).strict(),
  annotateHistory: object({ event_id: id, text: text(), reason, evidence: refs }).strict(),
  decideAnnotation: object({ annotation_id: id, action: z.enum(["accept", "reject"]), reason }).strict(),
  recordIntervention: object({ agent_id: id, kind: z.enum(["challenge", "probe", "closed_warning"]), reason, evidence: refs }).strict(),
  explainStage: object({ room_stage: nonempty(128), version_id: id.optional(), summary: text(), grounds: refs, disagreement: text(), uncertainty: text(), consequences: text(), next_action: text() }).strict(),
  createResult: object({ decision_id: id, version_id: id, actions: list(followUp), explanation: text() }).strict(),
  getResource: readQuery,
  readConsumer: object({ kind: z.enum(consumerKinds), id: id.optional(), cursor: nonempty().optional() }).strict().superRefine((v, c) => {
    const r = readQuery.safeParse(v);
    if (!r.success) for (const issue of r.error.issues) c.addIssue(issue);
  })
};
const consumerCommands = {
  "consumer.ac.read": "readConsumer",
  "consumer.ac.version.commit": "commitVersion",
  "consumer.ac.review.submit": "submitReview",
  "consumer.ac.review.publish": "publishReview",
  "consumer.ac.remark.record": "recordRemark",
  "consumer.ac.remark.set": "setRemark",
  "consumer.ac.request.create": "createRequest",
  "consumer.ac.request.route": "routeRequest",
  "consumer.ac.request.decide": "decideRequest",
  "consumer.ac.instruction.propose": "proposeInstruction",
  "consumer.ac.publication.propose": "proposePublication",
  "consumer.ac.history.annotate": "annotateHistory",
  "consumer.ac.intervention.record": "recordIntervention",
  "consumer.ac.stage.explain": "explainStage",
  "consumer.ac.result.create": "createResult"
};
const consumerEnvelope = object({ version: z.literal(1), command: z.string().refine((v) => Object.hasOwn(consumerCommands, v), "Unknown command"), registration_revision: z.number().int().min(1), request_id: nonempty(), room_id: nonempty(), caller_cid: cid, arguments: z.record(z.unknown()) }).strict();
function isProductCommand(value) {
  return Object.hasOwn(schemas, value) || value === "sendFile" || value === "downloadVersion";
}
export {
  audience,
  cid,
  consumerCommands,
  consumerEnvelope,
  hash,
  id,
  isProductCommand,
  limits,
  readQuery,
  ref,
  schemas
};
