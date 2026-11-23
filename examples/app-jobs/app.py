# /// script
# requires-python = ">=3.12"
# dependencies = ["marimo"]
# ///
import marimo

__generated_with = "0.25.2"
app = marimo.App(width="medium")


@app.cell
def _():
    import marimo as mo
    from marimohub.jobs import Jobs

    mo.stop(mo.app_meta().request is None, mo.md("Job result: 42"))
    jobs = Jobs()
    tag = {"app": "shared-history-demo-v1"}

    def read_history(kind, cursor=None):
        filters = {
            "completed": {"status": "succeeded"},
            "active": {"status": "active", "triggered_by_me": True},
        }
        return jobs.list_history(
            tag_key="app", tag_value=tag["app"], limit=1,
            cursor=cursor, **filters[kind],
        )

    return jobs, mo, read_history, tag


@app.cell
def _(mo):
    job_id = mo.ui.text(label="Job ID in this notebook")
    job_id
    return (job_id,)


@app.cell
def _(mo, read_history):
    get_page, set_page = mo.state({"items": [], "next_cursor": None})
    get_active, set_active = mo.state({"items": [], "next_cursor": None})

    def load_first(_):
        set_page(read_history("completed"))
        set_active(read_history("active"))

    mo.ui.button(label="Refresh history and my active runs", on_click=load_first)
    return get_active, get_page, set_active, set_page


@app.cell
def _(job_id, jobs, mo, tag):
    mo.ui.button(
        label="Submit",
        on_click=lambda _: jobs.trigger(
            job_id.value, parameters={"value": "42"}, tags=tag,
        ),
    )
    return


@app.cell
def _(get_active, get_page, mo, read_history, set_active, set_page):
    def history_panel(title, kind, page, set_page):
        return mo.vstack([
            mo.md(f"## {title}"),
            mo.ui.table(page["items"]),
            mo.ui.button(
                label=f"Next: {title}",
                disabled=page["next_cursor"] is None,
                on_click=lambda _: set_page(read_history(kind, page["next_cursor"])),
            ),
        ])

    mo.vstack([
        mo.md("An empty page can still have a next page."),
        history_panel("Shared completed history", "completed", get_page(), set_page),
        history_panel("My active runs", "active", get_active(), set_active),
    ])
    return


if __name__ == "__main__":
    app.run()
