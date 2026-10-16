import type { ModelRef } from "./contracts.js";

export const AUDIO_OPERATIONS = [
  "speech",
  "dialogue",
  "sound-effect",
  "music",
] as const;
export type AudioOperation = (typeof AUDIO_OPERATIONS)[number];

export const AUDIO_OUTPUT_FORMATS = ["mp3", "wav"] as const;
export type AudioOutputFormat = (typeof AUDIO_OUTPUT_FORMATS)[number];

export const AUDIO_VOICE_ID_MAX_LENGTH = 256;
export const AUDIO_VOICE_ID_PATTERN = "^[A-Za-z0-9_-]+$";
export const DOUBAO_SPEECH_PROVIDER_NAME = "Doubao Speech";

export const AUDIO_SAMPLE_RATES = [
  8_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000,
] as const;
export type AudioSampleRate = (typeof AUDIO_SAMPLE_RATES)[number];

export interface AudioOutputSettings {
  format?: AudioOutputFormat;
  sampleRate?: AudioSampleRate;
  channels?: 1 | 2;
}

export interface SpeechAudioRequest {
  operation: "speech";
  text: string;
  model?: ModelRef;
  /** Uses the provider's configured default when omitted. */
  voiceId?: string;
  language?: string;
  style?: string;
  speed?: number;
  output?: AudioOutputSettings;
}

export interface DialogueAudioRequest {
  operation: "dialogue";
  model?: ModelRef;
  turns: Array<{
    speaker: string;
    voiceId: string;
    text: string;
    style?: string;
  }>;
  output?: AudioOutputSettings;
}

export interface SoundEffectAudioRequest {
  operation: "sound-effect";
  model?: ModelRef;
  prompt: string;
  durationSeconds?: number;
  loop?: boolean;
  negativePrompt?: string;
  output?: AudioOutputSettings;
}

export interface MusicAudioRequest {
  operation: "music";
  model?: ModelRef;
  prompt: string;
  instrumental: boolean;
  lyrics?: string;
  durationSeconds?: number;
  loop?: boolean;
  referenceAssetId?: string;
  output?: AudioOutputSettings;
}

export type AudioGenerationRequest =
  | SpeechAudioRequest
  | DialogueAudioRequest
  | SoundEffectAudioRequest
  | MusicAudioRequest;

export interface AudioModelCapabilities {
  operations: AudioOperation[];
  executionModes: Array<"synchronous" | "streaming" | "async-task">;
  languages?: string[];
  formats: AudioOutputFormat[];
  sampleRates?: AudioSampleRate[];
  maxTextCharacters?: number;
  maxDurationSeconds?: number;
  maxSpeakers?: number;
  supportsSSML?: boolean;
  supportsVoiceClone?: boolean;
  supportsVoiceDesign?: boolean;
  supportsAlignment?: boolean;
  supportsLoop?: boolean;
  supportsLyrics?: boolean;
  supportsInstrumental?: boolean;
  supportsReferenceAudio?: boolean;
  supportsNegativePrompt?: boolean;
}

export interface AudioModel extends ModelRef {
  name: string;
  providerName: string;
  protocol: string;
  capabilities: AudioModelCapabilities;
}

export function availableAudioOperations(models: readonly AudioModel[]): Set<AudioOperation> {
  return new Set(models.flatMap((model) => model.capabilities.operations));
}

export interface AudioProviderCatalogStatus {
  provider: string;
  name: string;
  configured: boolean;
  state: "ready" | "not_configured" | "disabled" | "error";
  message?: string;
}

export interface AudioModelCatalog {
  models: AudioModel[];
  providers: AudioProviderCatalogStatus[];
}

export interface AudioMetadata {
  durationMs?: number;
  sampleRate?: number;
  channels?: number;
  codec?: string;
  providerRequestId?: string;
  usageCharacters?: number;
}

export interface GeneratedAudio {
  bytes: Uint8Array;
  mediaType: "audio/mpeg" | "audio/wav";
  model: ModelRef;
  metadata?: AudioMetadata;
}

export interface RunSpeechToolRequest extends Omit<
  SpeechAudioRequest,
  "operation"
> {}
export interface RunSoundEffectToolRequest extends Omit<
  SoundEffectAudioRequest,
  "operation"
> {}
export interface RunMusicToolRequest extends Omit<
  MusicAudioRequest,
  "operation"
> {}

export interface VolcengineTtsVoice {
  id: string;
  name: string;
  gender: "female" | "male";
  language: "zh-cn" | "en";
}

/**
 * Official Doubao Speech Synthesis 2.0 (seed-tts-2.0) preset voices.
 * The Volcengine ListSpeakers API needs AccessKey signing instead of the
 * console API key, so the catalog ships from the published voice list.
 * Cloned and custom voices can still be entered as raw Speaker IDs.
 */
export const VOLCENGINE_TTS_VOICES: readonly VolcengineTtsVoice[] = [
  voice("zh_female_vv_uranus_bigtts", "Vivi", "female", "zh-cn"),
  voice("zh_female_xiaohe_uranus_bigtts", "小何", "female", "zh-cn"),
  voice("zh_male_m191_uranus_bigtts", "云舟", "male", "zh-cn"),
  voice("zh_male_taocheng_uranus_bigtts", "小天", "male", "zh-cn"),
  voice("en_male_tim_uranus_bigtts", "Tim", "male", "en"),
  voice("en_female_dacey_uranus_bigtts", "Dacey", "female", "en"),
  voice("en_female_stokie_uranus_bigtts", "Stokie", "female", "en"),
  voice("zh_male_liufei_uranus_bigtts", "刘飞", "male", "zh-cn"),
  voice(
    "zh_female_qingxinnvsheng_uranus_bigtts",
    "清新女声",
    "female",
    "zh-cn",
  ),
  voice("zh_female_cancan_uranus_bigtts", "知性灿灿", "female", "zh-cn"),
  voice("zh_female_sajiaoxuemei_uranus_bigtts", "撒娇学妹", "female", "zh-cn"),
  voice(
    "zh_female_tianmeixiaoyuan_uranus_bigtts",
    "甜美小源",
    "female",
    "zh-cn",
  ),
  voice("zh_female_tianmeitaozi_uranus_bigtts", "甜美桃子", "female", "zh-cn"),
  voice(
    "zh_female_shuangkuaisisi_uranus_bigtts",
    "爽快思思",
    "female",
    "zh-cn",
  ),
  voice("zh_female_peiqi_uranus_bigtts", "佩奇猪", "female", "zh-cn"),
  voice("zh_female_linjianvhai_uranus_bigtts", "邻家女孩", "female", "zh-cn"),
  voice(
    "zh_male_shaonianzixin_uranus_bigtts",
    "少年梓辛 Brayan",
    "male",
    "zh-cn",
  ),
  voice("zh_male_sunwukong_uranus_bigtts", "猴哥", "male", "zh-cn"),
  voice("zh_female_yingyujiaoxue_uranus_bigtts", "Tina老师", "female", "zh-cn"),
  voice("zh_female_kefunvsheng_uranus_bigtts", "暖阳女声", "female", "zh-cn"),
  voice("zh_female_xiaoxue_uranus_bigtts", "儿童绘本", "female", "zh-cn"),
  voice("zh_male_dayi_uranus_bigtts", "大壹", "male", "zh-cn"),
  voice("zh_female_mizai_uranus_bigtts", "黑猫侦探社咪仔", "female", "zh-cn"),
  voice("zh_female_jitangnv_uranus_bigtts", "鸡汤女", "female", "zh-cn"),
  voice("zh_female_meilinvyou_uranus_bigtts", "魅力女友", "female", "zh-cn"),
  voice("zh_female_liuchangnv_uranus_bigtts", "流畅女声", "female", "zh-cn"),
  voice("zh_male_ruyayichen_uranus_bigtts", "儒雅逸辰", "male", "zh-cn"),
  voice("zh_female_wenroumama_uranus_bigtts", "温柔妈妈", "female", "zh-cn"),
  voice("zh_male_jieshuoxiaoming_uranus_bigtts", "解说小明", "male", "zh-cn"),
  voice("zh_female_tvbnv_uranus_bigtts", "TVB女声", "female", "zh-cn"),
  voice("zh_male_yizhipiannan_uranus_bigtts", "译制片男", "male", "zh-cn"),
  voice("zh_female_qiaopinv_uranus_bigtts", "俏皮女声", "female", "zh-cn"),
  voice(
    "zh_female_zhishuaiyingzi_uranus_bigtts",
    "直率英子",
    "female",
    "zh-cn",
  ),
  voice("zh_male_linjiananhai_uranus_bigtts", "邻家男孩", "male", "zh-cn"),
  voice("zh_male_silang_uranus_bigtts", "四郎", "male", "zh-cn"),
  voice("zh_male_ruyaqingnian_uranus_bigtts", "儒雅青年", "male", "zh-cn"),
  voice("zh_male_qingcang_uranus_bigtts", "擎苍", "male", "zh-cn"),
  voice("zh_male_xionger_uranus_bigtts", "熊二", "male", "zh-cn"),
  voice("zh_female_yingtaowanzi_uranus_bigtts", "樱桃丸子", "female", "zh-cn"),
  voice("zh_male_wennuanahu_uranus_bigtts", "温暖阿虎 Alvin", "male", "zh-cn"),
  voice("zh_male_naiqimengwa_uranus_bigtts", "奶气萌娃", "male", "zh-cn"),
  voice("zh_female_popo_uranus_bigtts", "婆婆", "female", "zh-cn"),
  voice("zh_female_gaolengyujie_uranus_bigtts", "高冷御姐", "female", "zh-cn"),
  voice("zh_male_aojiaobazong_uranus_bigtts", "傲娇霸总", "male", "zh-cn"),
  voice("zh_male_lanyinmianbao_uranus_bigtts", "懒音绵宝", "male", "zh-cn"),
  voice("zh_male_fanjuanqingnian_uranus_bigtts", "反卷青年", "male", "zh-cn"),
  voice("zh_female_wenroushunv_uranus_bigtts", "温柔淑女", "female", "zh-cn"),
  voice("zh_female_gufengshaoyu_uranus_bigtts", "古风少御", "female", "zh-cn"),
  voice("zh_male_huolixiaoge_uranus_bigtts", "活力小哥", "male", "zh-cn"),
  voice("zh_male_baqiqingshu_uranus_bigtts", "霸气青叔", "male", "zh-cn"),
  voice("zh_male_xuanyijieshuo_uranus_bigtts", "悬疑解说", "male", "zh-cn"),
  voice("zh_female_mengyatou_uranus_bigtts", "萌丫头 Cutey", "female", "zh-cn"),
  voice(
    "zh_female_tiexinnvsheng_uranus_bigtts",
    "贴心女声 Candy",
    "female",
    "zh-cn",
  ),
  voice(
    "zh_female_jitangmei_uranus_bigtts",
    "鸡汤妹妹 Hope",
    "female",
    "zh-cn",
  ),
  voice(
    "zh_male_cixingjieshuonan_uranus_bigtts",
    "磁性解说男声 Morgan",
    "male",
    "zh-cn",
  ),
  voice("zh_male_liangsangmengzai_uranus_bigtts", "亮嗓萌仔", "male", "zh-cn"),
  voice("zh_female_kailangjiejie_uranus_bigtts", "开朗姐姐", "female", "zh-cn"),
  voice("zh_male_gaolengchenwen_uranus_bigtts", "高冷沉稳", "male", "zh-cn"),
  voice("zh_male_shenyeboke_uranus_bigtts", "深夜播客", "male", "zh-cn"),
  voice("zh_male_lubanqihao_uranus_bigtts", "鲁班七号", "male", "zh-cn"),
  voice("zh_female_jiaochuannv_uranus_bigtts", "娇喘女声", "female", "zh-cn"),
  voice("zh_female_linxiao_uranus_bigtts", "林潇", "female", "zh-cn"),
  voice("zh_female_lingling_uranus_bigtts", "玲玲姐姐", "female", "zh-cn"),
  voice("zh_female_chunribu_uranus_bigtts", "春日部姐姐", "female", "zh-cn"),
  voice("zh_male_tangseng_uranus_bigtts", "唐僧", "male", "zh-cn"),
  voice("zh_male_zhuangzhou_uranus_bigtts", "庄周", "male", "zh-cn"),
  voice("zh_male_kailangdidi_uranus_bigtts", "开朗弟弟", "male", "zh-cn"),
  voice("zh_male_zhubajie_uranus_bigtts", "猪八戒", "male", "zh-cn"),
  voice(
    "zh_female_ganmaodianyin_uranus_bigtts",
    "感冒电音姐姐",
    "female",
    "zh-cn",
  ),
  voice("zh_female_chanmeinv_uranus_bigtts", "谄媚女声", "female", "zh-cn"),
  voice("zh_female_nvleishen_uranus_bigtts", "女雷神", "female", "zh-cn"),
  voice("zh_female_qinqienv_uranus_bigtts", "亲切女声", "female", "zh-cn"),
  voice("zh_male_kuailexiaodong_uranus_bigtts", "快乐小东", "male", "zh-cn"),
  voice("zh_male_kailangxuezhang_uranus_bigtts", "开朗学长", "male", "zh-cn"),
  voice("zh_male_youyoujunzi_uranus_bigtts", "悠悠君子", "male", "zh-cn"),
  voice("zh_female_wenjingmaomao_uranus_bigtts", "文静毛毛", "female", "zh-cn"),
  voice("zh_female_zhixingnv_uranus_bigtts", "知性女声", "female", "zh-cn"),
  voice("zh_male_qingshuangnanda_uranus_bigtts", "清爽男大", "male", "zh-cn"),
  voice("zh_male_yuanboxiaoshu_uranus_bigtts", "渊博小叔", "male", "zh-cn"),
  voice("zh_male_yangguangqingnian_uranus_bigtts", "阳光青年", "male", "zh-cn"),
  voice("zh_female_qingchezizi_uranus_bigtts", "清澈梓梓", "female", "zh-cn"),
  voice("zh_female_tianmeiyueyue_uranus_bigtts", "甜美悦悦", "female", "zh-cn"),
  voice("zh_female_xinlingjitang_uranus_bigtts", "心灵鸡汤", "female", "zh-cn"),
  voice("zh_male_wenrouxiaoge_uranus_bigtts", "温柔小哥", "male", "zh-cn"),
  voice("zh_female_roumeinvyou_uranus_bigtts", "柔美女友", "female", "zh-cn"),
  voice("zh_male_dongfanghaoran_uranus_bigtts", "东方浩然", "male", "zh-cn"),
  voice("zh_female_wenrouxiaoya_uranus_bigtts", "温柔小雅", "female", "zh-cn"),
  voice("zh_male_tiancaitongsheng_uranus_bigtts", "天才童声", "male", "zh-cn"),
  voice("zh_female_wuzetian_uranus_bigtts", "武则天", "female", "zh-cn"),
  voice("zh_female_gujie_uranus_bigtts", "顾姐", "female", "zh-cn"),
  voice("zh_male_guanggaojieshuo_uranus_bigtts", "广告解说", "male", "zh-cn"),
  voice("zh_female_shaoergushi_uranus_bigtts", "少儿故事", "female", "zh-cn"),
  voice("zh_female_sophie_uranus_bigtts", "魅力苏菲", "female", "zh-cn"),
];

function voice(
  id: string,
  name: string,
  gender: "female" | "male",
  language: "zh-cn" | "en",
): VolcengineTtsVoice {
  return { id, name, gender, language };
}
