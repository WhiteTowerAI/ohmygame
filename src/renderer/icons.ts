/*! Solar Icons by 480 Design (CC BY 4.0).
 * https://github.com/480-Design/Solar-Icon-Set
 * Drawn icons below fill gaps in the set on its 24px grid and 1.5 stroke.
 */
import {
  AddCircleIcon,
  AddFolderIcon,
  AddIcon,
  AltArrowDownIcon,
  AltArrowLeftIcon,
  AltArrowRightIcon,
  AltArrowUpIcon,
  ArchiveIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowToDownRightIcon,
  ArrowUpIcon,
  BalloonIcon,
  BellIcon,
  BookIcon,
  BotIcon,
  BoxIcon,
  BoxMinimalisticIcon,
  CameraIcon,
  CatIcon,
  ChatRoundLineIcon,
  ChatSquareIcon,
  CheckCircleIcon,
  ClipboardIcon,
  ClipboardListIcon,
  ClockCircleIcon,
  CloseCircleIcon,
  CloseIcon,
  CloudIcon,
  CloudSunIcon,
  Code2Icon,
  CodeFileIcon,
  CodeIcon,
  CompassIcon,
  CopyIcon,
  CpuIcon,
  CrownIcon,
  CupHotIcon,
  CursorIcon,
  DangerCircleIcon,
  DangerTriangleIcon,
  DatabaseIcon,
  DisketteIcon,
  DocumentAddIcon,
  DocumentTextIcon,
  DocumentsIcon,
  DownloadIcon,
  DownloadMinimalisticIcon,
  EyeIcon,
  FileIcon,
  FileTextIcon,
  FireIcon,
  FlagIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderWithFilesIcon,
  GalleryIcon,
  GalleryRemoveIcon,
  GalleryWideIcon,
  GameboyIcon,
  GamepadIcon,
  GhostSmileIcon,
  GlobalIcon,
  HamburgerMenuIcon,
  HashtagIcon,
  HeadphonesRoundSoundIcon,
  HeartIcon,
  HistoryIcon,
  HomeIcon,
  ImportIcon,
  InfoCircleIcon,
  KeyIcon,
  LaptopMinimalisticIcon,
  LayersIcon,
  LeafIcon,
  LightbulbIcon,
  LoginIcon,
  MagicWandIcon,
  MagnifierIcon,
  MaximizeIcon,
  MenuDotsIcon,
  MinimizeIcon,
  MinusIcon,
  MonitorIcon,
  MoonIcon,
  MusicNoteIcon,
  PaletteIcon,
  PaperclipIcon,
  PauseIcon,
  Pen2Icon,
  PenIcon,
  PenNewSquareIcon,
  PlanetIcon,
  PlayIcon,
  PlugCircleIcon,
  ProgrammingIcon,
  QuestionCircleIcon,
  RefreshIcon,
  RestartIcon,
  RocketIcon,
  RoutingIcon,
  ScissorsIcon,
  ServerIcon,
  SettingsIcon,
  SettingsMinimalisticIcon,
  ShareIcon,
  SidebarCodeIcon,
  SidebarMinimalisticIcon,
  SmartphoneIcon,
  SpeedometerMiddleIcon,
  SquareArrowRightUpIcon,
  StarIcon,
  StarsIcon,
  StopCircleIcon,
  StopIcon,
  SubtitlesIcon,
  SunIcon,
  TabletIcon,
  TextFieldIcon,
  TextSquareIcon,
  ToolboxIcon,
  TrashBinMinimalisticIcon,
  Tuning2Icon,
  UfoIcon,
  UmbrellaIcon,
  UndoLeftIcon,
  UndoRightIcon,
  UploadIcon,
  UserIcon,
  UserRoundedIcon,
  UsersGroupRoundedIcon,
  VideoFrameIcon,
  VolumeCrossIcon,
  VolumeLoudIcon,
  WiFiIcon,
  Widget4Icon,
  WidgetIcon,
  WindowFrameIcon,
  LibraryIcon,
  RunningIcon,
} from "@solar-icons/react/linear";
import {
  FolderWithFilesIcon as FolderWithFilesBoldIcon,
  HomeIcon as HomeBoldIcon,
  LayersIcon as LayersBoldIcon,
  PlugCircleIcon as PlugCircleBoldIcon,
  UsersGroupRoundedIcon as UsersGroupRoundedBoldIcon,
} from "@solar-icons/react/bold";
import type { Icon as SolarIcon, IconProps as SolarIconProps } from "@solar-icons/react/lib/types";
import { createElement, forwardRef, type ForwardRefExoticComponent, type RefAttributes } from "react";

/** Named icon sizes in px; keep in step with --icon-size-* in tokens.css. */
export const ICON_SIZES = { xs: 12, sm: 14, md: 16, lg: 20 } as const;
export type IconSize = keyof typeof ICON_SIZES;
export type IconProps = Omit<SolarIconProps, "size" | "ref"> & { size?: IconSize | number };
export type IconComponent = ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>;

function iconPx(size: IconProps["size"]): number {
  return typeof size === "number" ? size : ICON_SIZES[size ?? "md"];
}

/** A 24-unit stroke that draws 1.25px on screen; icons past 20px keep Solar's own 1.5. */
export function iconStroke(px: number): number {
  return Math.round(Math.max(1.5, (1.25 * 24) / px) * 1000) / 1000;
}

function icon(Base: SolarIcon): IconComponent {
  const Icon = forwardRef<SVGSVGElement, IconProps>(function Icon({ size, strokeWidth, ...props }, ref) {
    const px = iconPx(size);
    return createElement(Base, { ref, ...props, size: px, strokeWidth: strokeWidth ?? iconStroke(px) });
  });
  Icon.displayName = Base.displayName;
  return Icon;
}

type Shape = readonly [tag: "path" | "circle", attrs: Record<string, string | number>];

/** An icon drawn here, sized and stroked like the Solar ones. */
function drawn(name: string, shapes: readonly Shape[], extraClass?: string): IconComponent {
  const Icon = forwardRef<SVGSVGElement, IconProps>(function Icon(
    { size, strokeWidth, className, style, color, alt, children, secondaryColor: _secondary, secondaryOpacity: _opacity, iconName: _name, isolated: _isolated, ...props },
    ref,
  ) {
    const px = iconPx(size);
    const labelled = Boolean(alt) || props["aria-label"] !== undefined;
    return createElement(
      "svg",
      {
        ref,
        xmlns: "http://www.w3.org/2000/svg",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeLinecap: "round",
        strokeLinejoin: "round",
        ...(labelled ? {} : { "aria-hidden": "true" }),
        ...props,
        className: ["solar", `solar-${name}`, extraClass, className].filter(Boolean).join(" "),
        style: { width: px, height: px, strokeWidth: strokeWidth ?? iconStroke(px), ...(color ? { color } : {}), ...style },
      },
      alt ? createElement("title", null, alt) : null,
      ...shapes.map(([tag, attrs], key) => createElement(tag, { key, ...attrs })),
      children,
    );
  });
  Icon.displayName = name;
  return Icon;
}

export const Check = drawn("check-linear", [["path", { d: "M4.5 12.5L9 17L19.5 6.5" }]]);

export const Hand = drawn("hand-linear", [
  ["path", { d: "M8 13.5V5.75C8 4.92 8.67 4.25 9.5 4.25C10.33 4.25 11 4.92 11 5.75V11" }],
  ["path", { d: "M11 11V4.25C11 3.42 11.67 2.75 12.5 2.75C13.33 2.75 14 3.42 14 4.25V11" }],
  ["path", { d: "M14 11V5.75C14 4.92 14.67 4.25 15.5 4.25C16.33 4.25 17 4.92 17 5.75V12" }],
  ["path", { d: "M17 12V8.75C17 7.92 17.67 7.25 18.5 7.25C19.33 7.25 20 7.92 20 8.75V14C20 18.42 16.92 21.25 13 21.25H12.5C10.4 21.25 9.1 20.6 7.8 19.2L4.45 15.6C3.88 14.98 3.92 14.02 4.55 13.45C5.12 12.94 5.98 12.95 6.54 13.47L8 14.8" }],
]);

export const Move = drawn("move-linear", [
  ["path", { d: "M12 3V21" }],
  ["path", { d: "M3 12H21" }],
  ["path", { d: "M9.5 5.5L12 3L14.5 5.5" }],
  ["path", { d: "M9.5 18.5L12 21L14.5 18.5" }],
  ["path", { d: "M5.5 9.5L3 12L5.5 14.5" }],
  ["path", { d: "M18.5 9.5L21 12L18.5 14.5" }],
]);

/** Six dots for drag handles. */
export const Grip = drawn("grip-linear", [9, 15].flatMap((cx) => [6, 12, 18].map((cy): Shape => ["circle", { cx, cy, r: 1, fill: "currentColor" }])));

/** A quarter arc over a faint ring; spins on its own. */
export const Spinner = drawn("spinner-linear", [
  ["path", { d: "M21 12C21 16.97 16.97 21 12 21C7.03 21 3 16.97 3 12C3 7.03 7.03 3 12 3", opacity: 0.25 }],
  ["path", { d: "M12 3C16.97 3 21 7.03 21 12" }],
], "spin");

/*! Solar Icons by 480 Design (CC BY 4.0): git-branch-linear, not exported by @solar-icons/react.
 * Source: https://github.com/iconify/icon-sets/blob/master/json/solar.json
 */
export const GitBranch = drawn("git-branch-linear", [
  ["path", { d: "M9 4.5C9 5.88071 7.88071 7 6.5 7C5.11929 7 4 5.88071 4 4.5C4 3.11929 5.11929 2 6.5 2C7.88071 2 9 3.11929 9 4.5Z" }],
  ["path", { d: "M20.1821 7.5C20.1821 8.88071 19.0628 10 17.6821 10C16.3014 10 15.1821 8.88071 15.1821 7.5C15.1821 6.11929 16.3014 5 17.6821 5C19.0628 5 20.1821 6.11929 20.1821 7.5Z" }],
  ["path", { d: "M9 19.5C9 20.8807 7.88071 22 6.5 22C5.11929 22 4 20.8807 4 19.5C4 18.1193 5.11929 17 6.5 17C7.88071 17 9 18.1193 9 19.5Z" }],
  ["path", { d: "M6.5 17L6.5 7" }],
  ["path", { d: "M17.6821 10C17.6821 12.3383 15.4514 13.5914 12.0878 13.5914C8.72419 13.5914 6.5 14.6747 6.5 17" }],
]);

export const Circle = drawn("circle-linear", [["circle", { cx: 12, cy: 12, r: 9 }]]);

export const CircleDot = drawn("circle-dot-linear", [
  ["circle", { cx: 12, cy: 12, r: 9 }],
  ["circle", { cx: 12, cy: 12, r: 3, fill: "currentColor", stroke: "none" }],
]);

export const Archive = icon(ArchiveIcon);
export const ArrowDownToLine = icon(DownloadMinimalisticIcon);
export const ArrowLeft = icon(ArrowLeftIcon);
export const ArrowRight = icon(ArrowRightIcon);
export const ArrowUp = icon(ArrowUpIcon);
export const Balloon = icon(BalloonIcon);
export const Bell = icon(BellIcon);
export const Book = icon(BookIcon);
export const Bot = icon(BotIcon);
export const Box = icon(BoxIcon);
export const Brush = icon(Pen2Icon);
export const Camera = icon(CameraIcon);
export const Captions = icon(SubtitlesIcon);
export const Cat = icon(CatIcon);
export const ChatSquare = icon(ChatSquareIcon);
export const ChevronDown = icon(AltArrowDownIcon);
export const ChevronLeft = icon(AltArrowLeftIcon);
export const ChevronRight = icon(AltArrowRightIcon);
export const ChevronUp = icon(AltArrowUpIcon);
export const CircleCheck = icon(CheckCircleIcon);
export const CircleHelp = icon(QuestionCircleIcon);
export const CirclePlus = icon(AddCircleIcon);
export const CircleStop = icon(StopCircleIcon);
export const CircleX = icon(CloseCircleIcon);
export const Clipboard = icon(ClipboardIcon);
export const ClipboardList = icon(ClipboardListIcon);
export const Clock = icon(ClockCircleIcon);
export const Cloud = icon(CloudIcon);
export const CloudSun = icon(CloudSunIcon);
export const Code = icon(CodeIcon);
export const Code2 = icon(Code2Icon);
export const Columns2 = icon(SidebarCodeIcon);
export const Compass = icon(CompassIcon);
export const Copy = icon(CopyIcon);
export const CornerDownRight = icon(ArrowToDownRightIcon);
export const Cpu = icon(CpuIcon);
export const Crown = icon(CrownIcon);
export const CupHot = icon(CupHotIcon);
export const DangerCircle = icon(DangerCircleIcon);
export const Database = icon(DatabaseIcon);
export const Diskette = icon(DisketteIcon);
export const Download = icon(DownloadIcon);
export const Duplicate = icon(DocumentsIcon);
export const ExternalLink = icon(SquareArrowRightUpIcon);
export const Eye = icon(EyeIcon);
export const FileCode2 = icon(CodeFileIcon);
export const FileDocument = icon(DocumentTextIcon);
export const FilePlain = icon(FileIcon);
export const FilePlus = icon(DocumentAddIcon);
export const FileStyle = icon(HashtagIcon);
export const FileText = icon(FileTextIcon);
export const Film = icon(VideoFrameIcon);
export const Fire = icon(FireIcon);
export const Flag = icon(FlagIcon);
export const Folder = icon(FolderIcon);
export const FolderOpen = icon(FolderOpenIcon);
export const FolderPlus = icon(AddFolderIcon);
export const FolderWithFiles = icon(FolderWithFilesIcon);
export const GalleryWide = icon(GalleryWideIcon);
export const Gameboy = icon(GameboyIcon);
export const Gamepad2 = icon(GamepadIcon);
export const Gauge = icon(SpeedometerMiddleIcon);
export const GhostSmile = icon(GhostSmileIcon);
export const Globe2 = icon(GlobalIcon);
export const Headphones = icon(HeadphonesRoundSoundIcon);
export const Heart = icon(HeartIcon);
export const History = icon(HistoryIcon);
export const House = icon(HomeIcon);
export const Image = icon(GalleryIcon);
export const ImageOff = icon(GalleryRemoveIcon);
export const Import = icon(ImportIcon);
export const InfoCircle = icon(InfoCircleIcon);
export const Key = icon(KeyIcon);
export const LaptopMinimalistic = icon(LaptopMinimalisticIcon);
export const Layers3 = icon(LayersIcon);
export const LayoutGrid = icon(Widget4Icon);
export const Library = icon(LibraryIcon);
export const Leaf = icon(LeafIcon);
export const Lightbulb = icon(LightbulbIcon);
export const List = icon(HamburgerMenuIcon);
export const LogIn = icon(LoginIcon);
export const Maximize = icon(MaximizeIcon);
export const MessageCircle = icon(ChatRoundLineIcon);
export const MessageSquarePlus = icon(PenNewSquareIcon);
export const Minimize = icon(MinimizeIcon);
export const Minus = icon(MinusIcon);
export const Monitor = icon(MonitorIcon);
export const Moon = icon(MoonIcon);
export const MoreHorizontal = icon(MenuDotsIcon);
export const MousePointer2 = icon(CursorIcon);
export const Music2 = icon(MusicNoteIcon);
export const Package = icon(BoxMinimalisticIcon);
export const Palette = icon(PaletteIcon);
export const PanelToggle = icon(SidebarMinimalisticIcon);
export const Paperclip = icon(PaperclipIcon);
export const Pause = icon(PauseIcon);
export const Pencil = icon(PenIcon);
export const Planet = icon(PlanetIcon);
export const Play = icon(PlayIcon);
export const Plug = icon(PlugCircleIcon);
export const Running = icon(RunningIcon);
export const Plus = icon(AddIcon);
export const Redo2 = icon(UndoRightIcon);
export const RefreshCw = icon(RefreshIcon);
export const Rocket = icon(RocketIcon);
export const RotateCcw = icon(RestartIcon);
export const Routing = icon(RoutingIcon);
export const Scissors = icon(ScissorsIcon);
export const Search = icon(MagnifierIcon);
export const Server = icon(ServerIcon);
export const Settings = icon(SettingsIcon);
export const SettingsMinimal = icon(SettingsMinimalisticIcon);
export const Share2 = icon(ShareIcon);
export const SlidersHorizontal = icon(Tuning2Icon);
export const Smartphone = icon(SmartphoneIcon);
export const Sparkles = icon(StarsIcon);
export const Star = icon(StarIcon);
export const Stop = icon(StopIcon);
export const Sun = icon(SunIcon);
export const Tablet = icon(TabletIcon);
export const Terminal = icon(ProgrammingIcon);
export const TextField = icon(TextFieldIcon);
export const Toolbox = icon(ToolboxIcon);
export const Trash2 = icon(TrashBinMinimalisticIcon);
export const TriangleAlert = icon(DangerTriangleIcon);
export const Type = icon(TextSquareIcon);
export const Ufo = icon(UfoIcon);
export const Umbrella = icon(UmbrellaIcon);
export const Undo2 = icon(UndoLeftIcon);
export const Upload = icon(UploadIcon);
export const User = icon(UserIcon);
export const UserRound = icon(UserRoundedIcon);
export const UsersGroupRounded = icon(UsersGroupRoundedIcon);
export const Volume2 = icon(VolumeLoudIcon);
export const VolumeX = icon(VolumeCrossIcon);
export const WandSparkles = icon(MagicWandIcon);
export const Widget = icon(WidgetIcon);
export const Wifi = icon(WiFiIcon);
export const WindowFrame = icon(WindowFrameIcon);
export const X = icon(CloseIcon);

/** Filled versions for the sidebar page that is open. */
export const HouseBold = icon(HomeBoldIcon);
export const FolderWithFilesBold = icon(FolderWithFilesBoldIcon);
export const Layers3Bold = icon(LayersBoldIcon);
export const UsersGroupRoundedBold = icon(UsersGroupRoundedBoldIcon);
export const PlugBold = icon(PlugCircleBoldIcon);
