export async function getServerSideProps(context) {
  return {
    props: {
      slug: context.params.slug,
    },
  }
}

export default function DynamicPage(props) {
  return <div id="page">{props.slug}</div>
}
