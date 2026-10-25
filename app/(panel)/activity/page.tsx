import { PanelPage } from "@/components/panel/panel-page";

export default function ActivityPage(props: PageProps<"/activity">) {
  return <PanelPage view="activity" searchParams={props.searchParams} />;
}
