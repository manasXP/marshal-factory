import { PanelPage } from "@/components/panel/panel-page";

export default function BoardPage(props: PageProps<"/">) {
  return <PanelPage view="board" searchParams={props.searchParams} />;
}
