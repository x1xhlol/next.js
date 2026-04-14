export async function getServerSideProps() {
  return {
    props: {
      kind: 'gssp',
    },
  }
}

export default function GsspPage(props) {
  return <div id="page">{props.kind}</div>
}
