// A question to the person (ASK-1): the agent asks one question with a few options, the chat
// shows it as a card, and the run ends its turn there. The person's choice, or an answer they
// type, is their next message, and the agent goes on from it.

/** The agent's tool that asks the person one question. */
export const ASK_QUESTION_TOOL_NAME = "ask_question";

/** How many options a question offers: at least two, at most four. */
export const QUESTION_OPTIONS_MIN = 2;
export const QUESTION_OPTIONS_MAX = 4;

/** The most characters of a question, of an option's label and of its one line. */
export const QUESTION_MAX_LENGTH = 300;
export const QUESTION_OPTION_LABEL_MAX_LENGTH = 80;
export const QUESTION_OPTION_DESCRIPTION_MAX_LENGTH = 160;
