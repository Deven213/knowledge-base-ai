// What a patient is told before a consultation is recorded, in the three languages the product supports.
//
// DRAFT WORDING: this text must be reviewed by your clinical and legal lead before it is used with real patients (consent
// law differs by country and by clinic). When the wording changes, change CONSENT_VERSION: the server stores the version and
// a fingerprint of the exact words with every consent, so it can always be shown later what a patient was told.

export const CONSENT_VERSION = "2026-10-draft-2";
export const CONSENT_LANGUAGES = ["en", "hi", "gu"] as const;
export type ConsentLanguage = (typeof CONSENT_LANGUAGES)[number];

export interface ConsentText {
  title: string;
  statements: readonly string[];
}

export const CONSENT_TEXT: Record<ConsentLanguage, ConsentText> = {
  en: {
    title: "Consent to record this consultation",
    statements: [
      "This consultation will be audio-recorded so that a written clinical note can be prepared.",
      "The recording is stored securely and converted to text by an AI service. The doctor reads and approves the note before it is used.",
      "Only the doctor and the clinic staff who need it will have access. Apart from the AI service that turns the speech into text, it is not shared with anyone else.",
      "You may say no, and your care will not be affected. You can ask for the recording to be stopped, or deleted, at any time.",
    ],
  },
  hi: {
    title: "इस परामर्श की रिकॉर्डिंग के लिए सहमति",
    statements: [
      "इस परामर्श की ऑडियो रिकॉर्डिंग की जाएगी ताकि लिखित क्लिनिकल नोट तैयार किया जा सके।",
      "रिकॉर्डिंग सुरक्षित रूप से रखी जाती है और एक AI सेवा द्वारा लिखित रूप में बदली जाती है। उपयोग से पहले डॉक्टर नोट को पढ़कर स्वीकृत करते हैं।",
      "केवल डॉक्टर और आवश्यक क्लिनिक कर्मचारी ही इसे देख सकेंगे। बोले गए शब्दों को लिखित रूप में बदलने वाली AI सेवा के अलावा इसे किसी और के साथ साझा नहीं किया जाता।",
      "आप मना कर सकते हैं, इससे आपके इलाज पर कोई असर नहीं पड़ेगा। आप किसी भी समय रिकॉर्डिंग रोकने या हटाने के लिए कह सकते हैं।",
    ],
  },
  gu: {
    title: "આ પરામર્શ રેકોર્ડ કરવા માટે સંમતિ",
    statements: [
      "આ પરામર્શનું ઑડિયો રેકોર્ડિંગ કરવામાં આવશે, જેથી લેખિત ક્લિનિકલ નોંધ તૈયાર કરી શકાય.",
      "રેકોર્ડિંગ સુરક્ષિત રીતે સંગ્રહિત થાય છે અને AI સેવા દ્વારા લખાણમાં ફેરવાય છે. ઉપયોગ પહેલાં ડૉક્ટર નોંધ વાંચીને મંજૂર કરે છે.",
      "ફક્ત ડૉક્ટર અને જરૂરી ક્લિનિક સ્ટાફ જ તેને જોઈ શકશે. બોલાયેલા શબ્દોને લખાણમાં ફેરવતી AI સેવા સિવાય તે બીજા કોઈને આપવામાં આવતું નથી.",
      "તમે ના પાડી શકો છો, તેનાથી તમારી સારવાર પર કોઈ અસર થશે નહીં. તમે ગમે ત્યારે રેકોર્ડિંગ બંધ કરવા અથવા કાઢી નાખવા માટે કહી શકો છો.",
    ],
  },
};

export const CONSENT_GIVEN_BY = [
  { value: "patient", label: "The patient" },
  { value: "guardian", label: "The patient's parent or legal guardian" },
  { value: "representative", label: "Another authorised representative" },
] as const;
export type ConsentGivenBy = (typeof CONSENT_GIVEN_BY)[number]["value"];

export const CONSENT_METHODS = [
  { value: "verbal", label: "Verbal: I read this to them and they agreed" },
  { value: "written", label: "Written: they signed a consent form that the clinic keeps" },
] as const;
export type ConsentMethod = (typeof CONSENT_METHODS)[number]["value"];
